const { readData, writeData, mergeArray } = require('../lib/kv-data');

process.env.TZ = 'Europe/Madrid';

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const WEB_API_KEY = process.env.WEB_API_KEY || '';
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Nymara Estilistas';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function normPhone(p) {
  const d = (p||'').replace(/[^0-9]/g, '');
  return d.length > 9 ? d.slice(-9) : d;
}

function parseTime(t) {
  if (!t || typeof t !== 'string') return 0;
  const p = t.split(':');
  return (parseInt(p[0])||0) + (parseInt(p[1])||0) / 60;
}

function getOpeningHoursForDay(dateStr, settings) {
  if (!settings || !settings.openingHours) return { open: 9, close: 19, closed: false };
  const d = new Date(dateStr + 'T12:00:00').getDay();
  const day = settings.openingHours[d] || { open: '09:00', close: '19:00', closed: false };
  const openH = parseInt(day.open) || 9;
  const closeH = parseInt(day.close) || 19;
  const openMin = parseInt((day.open || '09:00').split(':')[1]) || 0;
  const closeMin = parseInt((day.close || '19:00').split(':')[1]) || 0;
  return {
    open: openH + openMin / 60,
    close: closeH + closeMin / 60,
    closed: day.closed === true
  };
}

function calcServiceDurationWithBlocks(servicesList, settings) {
  const bloques = settings && settings.bloques ? settings.bloques : {};
  const gap = bloques.bloqueGap || 45;
  const bloque1Svcs = servicesList.filter(s => s.bloque === 'bloque1');
  const bloque2Svcs = servicesList.filter(s => s.bloque === 'bloque2');
  const otherSvcs = servicesList.filter(s => s.bloque !== 'bloque1' && s.bloque !== 'bloque2');
  const bloque1Dur = bloque1Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
  const bloque2Dur = bloque2Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
  const otherDur = otherSvcs.reduce((sum, s) => sum + (s.duration || 30), 0);
  let total = otherDur;
  if (bloque1Svcs.length && bloque2Svcs.length) {
    total += bloque1Dur + gap + bloque2Dur;
  } else if (bloque1Svcs.length) {
    total += bloque1Dur;
  } else if (bloque2Svcs.length) {
    total += bloque2Dur;
  }
  return total;
}

function computeETag(data) {
  const hash = require('crypto').createHash('md5').update(JSON.stringify(data)).digest('hex');
  return '"' + hash + '"';
}

function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const s = url.trim();
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:image/')) return s;
  return '';
}

function requireWebAuth(req) {
  if (!WEB_API_KEY) return true;
  const auth = req.headers['authorization'] || '';
  return auth === 'Bearer ' + WEB_API_KEY || auth === WEB_API_KEY;
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleClientLogin(phone, res) {
  const norm = normPhone(phone);
  const d = await readData();
  const client = (d.clients||[]).find(c => normPhone(c.phone) === norm && !c._deleted);
  if (!client) {
    res.status(404).json({ error: 'Cliente no encontrado. ¿El teléfono está registrado?' });
    return;
  }
  const today = new Date().toISOString().split('T')[0];
  const appointments = (d.appointments||[]).filter(a => a.clientId === client.id && a.date >= today && (!a._deleted || a.cancelledBy === 'client' || a.cancelledBy === 'salon')).sort((a,b) => (a.date+' '+a.time).localeCompare(b.date+' '+b.time));
  const svcMap = {}; (d.services||[]).forEach(s => svcMap[s.id] = s);
  const empMap = {}; (d.employees||[]).forEach(e => empMap[e.id] = e);
  appointments.sort((a,b) => (a.date+' '+a.time).localeCompare(b.date+' '+b.time));
  res.json({
    client: { id: client.id, name: client.name, phone: client.phone, email: client.email || '', historialTecnico: client.historialTecnico || '', punctuality: client.punctuality || '' },
    appointments: appointments.map(a => {
      const svcIds = a.serviceIds || (a.serviceId ? [a.serviceId] : []);
      const svcNames = svcIds.map(id => svcMap[id] ? svcMap[id].name : null).filter(Boolean);
      return {
        id: a.id, date: a.date, time: a.time, endTime: a.endTime || '',
        serviceIds: svcIds, serviceId: a.serviceId || svcIds[0] || '',
        serviceName: svcNames.join(', '),
        status: a.status, source: a.source || '',
        employeeId: a.employeeId || '',
        employeeName: a.employeeId && empMap[a.employeeId] ? empMap[a.employeeId].name : '',
        notes: a.notes || '',
        _deleted: !!a._deleted, cancelledBy: a.cancelledBy || '',
        salonModified: !!a.salonModified, modificationCount: a.modificationCount || 0,
        clientModified: !!a.clientModified, pendingTime: a.pendingTime || '', pendingDate: a.pendingDate || '',
        pendingEmployeeId: a.pendingEmployeeId || '',
        pendingEmployeeName: a.pendingEmployeeId && empMap[a.pendingEmployeeId] ? empMap[a.pendingEmployeeId].name : ''
      };
    })
  });
}

// Email config
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
    transporter.verify().then(() => console.log('Email: SMTP OK')).catch(e => console.warn('Email: SMTP verify failed:', e.message));
  } catch (e) { console.warn('Email: nodemailer not available:', e.message); }
}

function sendConfirmationEmail(clientEmail, clientName, date, time, serviceName, employeeName, notes) {
  if (!transporter || !clientEmail) return false;
  const msg = {
    from: SMTP_FROM, to: clientEmail,
    subject: 'Cita confirmada - ' + BUSINESS_NAME,
    html: `<div style="font-family:Arial;max-width:500px;margin:0 auto;">
      <h2 style="color:#6C3483;">${BUSINESS_NAME}</h2>
      <p>Hola <strong>${clientName}</strong>,</p>
      <p>Tu cita ha sido confirmada:</p>
      <table style="background:#f5f2f7;border-radius:8px;padding:15px;margin:15px 0;width:100%;">
        <tr><td style="padding:4px 10px;color:#666;">Servicio</td><td><strong>${serviceName}</strong></td></tr>
        <tr><td style="padding:4px 10px;color:#666;">Fecha</td><td><strong>${date}</strong></td></tr>
        <tr><td style="padding:4px 10px;color:#666;">Hora</td><td><strong>${time}</strong></td></tr>
        ${employeeName ? `<tr><td style="padding:4px 10px;color:#666;">Profesional</td><td><strong>${employeeName}</strong></td></tr>` : ''}
        ${notes ? `<tr><td style="padding:4px 10px;color:#666;">Notas</td><td>${notes}</td></tr>` : ''}
      </table>
      <p style="color:#999;font-size:12px;">Te esperamos!<br>${BUSINESS_NAME}</p>
    </div>`
  };
  transporter.sendMail(msg, (err, info) => {
    if (err) console.error('Email send error:', err.message);
    else console.log('Email sent to', clientEmail, info.messageId);
  });
  return true;
}

module.exports = async (req, res) => {
  // Set CORS headers
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const url = req.url.split('?')[0].split('#')[0];

  // === DEBUG: check env + Twilio ===
  if (url === '/api/debug' && req.method === 'GET') {
    const wa = process.env.TWILIO_WHATSAPP_NUMBER || '';
    const ph = process.env.TWILIO_PHONE_NUMBER || '';
    const sid = process.env.TWILIO_ACCOUNT_SID || '';
    const token = process.env.TWILIO_AUTH_TOKEN || '';
    let twilio = { error: null };
    try {
      const auth = Buffer.from(sid + ':' + token).toString('base64');
      const bal = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '.json', {
        headers: { Authorization: 'Basic ' + auth }
      });
      const balData = await bal.json();
      const bal2 = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Balance.json', {
        headers: { Authorization: 'Basic ' + auth }
      });
      const bal2Data = await bal2.json();
      const msg = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json?PageSize=1', {
        headers: { Authorization: 'Basic ' + auth }
      });
      const msgData = await msg.json();
      twilio = {
        status: balData.status,
        type: balData.type,
        balance: bal2Data.balance || bal2Data.error || 'unknown',
        currency: bal2Data.currency || '',
        lastMessage: (msgData.messages || []).slice(0,1).map(m => ({
          status: m.status, errorCode: m.error_code, errorMessage: m.error_message,
          direction: m.direction, dateSent: m.date_sent
        }))[0] || null
      };
    } catch (e) { twilio.error = e.message; }
    res.json({
      whatsappNumber: wa ? wa.slice(0,6)+'...'+wa.slice(-4) : '(empty)',
      phoneNumber: ph ? ph.slice(0,6)+'...'+ph.slice(-4) : '(empty)',
      accountSid: sid ? sid.slice(0,6)+'...' : '(empty)',
      groqKeySet: !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'tu_groq_api_key_aqui'),
      businessPhone: process.env.BUSINESS_PHONE || '',
      twilio
    });
    return;
  }

  // === TEST SEND ===
  if (url === '/api/test-send' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      const to = b.to || '+34678092305';
      const text = b.text || 'Test desde Nymara';
      const { sendMessage } = require('../lib/whatsapp');
      const result = await sendMessage(to, text);
      res.json({ sent: true, result: result.error || result.status + ' ' + (result.sid||'') });
    } catch (e) { res.status(500).json({ error: e.message }); }
    return;
  }

  // === SEND WHATSAPP CONFIRMATION ===
  if (url === '/api/send-confirmation' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      const { appointmentId } = b;
      if (!appointmentId) { res.status(400).json({ error: 'appointmentId required' }); return; }
      const d = await readData();
      const appt = (d.appointments||[]).find(a => a.id === appointmentId);
      if (!appt) { res.status(404).json({ error: 'Appointment not found' }); return; }
      const client = (d.clients||[]).find(c => c.id === appt.clientId);
      if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
      const svc = (d.services||[]).find(s => s.id === (appt.serviceId||'')) || {};
      const emp = (d.employees||[]).find(e => e.id === appt.employeeId) || {};
      const dateFmt = appt.date ? appt.date.split('-').reverse().join('-') : '';
      const text = `✅ Tu cita en ${BUSINESS_NAME} ha sido CONFIRMADA:\n\n📅 ${dateFmt}\n⏰ ${appt.time}${appt.endTime ? ' - '+appt.endTime : ''}\n💇 ${svc.name || 'Servicio'}\n${emp.name ? '👤 '+emp.name : ''}\n\n¡Te esperamos!`;
      const { sendMessage } = require('../lib/whatsapp');
      const result = await sendMessage(client.phone, text);
      res.json({ sent: true, phone: client.phone, result: result.error || result.status + ' ' + (result.sid||'') });
    } catch (e) { res.status(500).json({ error: e.message }); }
    return;
  }

  // === SEND CUSTOM WHATSAPP ===
  if (url === '/api/send-whatsapp' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      const { phone, text } = b;
      if (!phone || !text) { res.status(400).json({ error: 'phone and text required' }); return; }
      const { sendMessage } = require('../lib/whatsapp');
      const result = await sendMessage(phone, text);
      res.json({ sent: true, phone, result: result.error || result.status + ' ' + (result.sid||'') });
    } catch (e) { res.status(500).json({ error: e.message }); }
    return;
  }

  // === SYNC ===
  if (url === '/sync' || url === '/sync/') {
    if (req.method === 'GET') {
      const data = await readData();
      res.setHeader('Content-Type', 'application/json');
      res.json(data);
      return;
    }
    if (req.method === 'POST') {
      try {
        const remote = await getBody(req);
        const current = await readData();
        const merged = { ...current };
        ['appointments', 'clients', 'services', 'employees', 'products', 'projects', 'movements', 'sections', 'providers'].forEach(k => {
          if (Array.isArray(remote[k])) {
            merged[k] = mergeArray(Array.isArray(current[k]) ? current[k] : [], remote[k]);
          }
        });
        merged.settings = remote.settings || current.settings || {};
        // Auto-clean old salon-cancelled appointments
        const today = new Date().toISOString().split('T')[0];
        (merged.appointments||[]).forEach(a => {
          if (a.cancelledBy === 'salon' && (a.date < today || a.source !== 'online')) {
            a._deleted = true; delete a.cancelledBy; a._modified = Date.now();
          }
        });
        await writeData(merged);
        console.log('POST /sync: stored',
          (remote.products||[]).length, 'products,',
          (remote.appointments||[]).length, 'appointments,',
          (remote.clients||[]).length, 'clients');
        res.json({
          ok: true,
          appointments: (Array.isArray(merged.appointments) ? merged.appointments : []).length,
          clients: (Array.isArray(merged.clients) ? merged.clients : []).length,
          services: (Array.isArray(merged.services) ? merged.services : []).length,
          employees: (Array.isArray(merged.employees) ? merged.employees : []).length,
          lastModified: merged.lastModified
        });
      } catch (e) {
        console.error('POST /sync error:', e);
        res.status(400).json({ error: e.message });
      }
      return;
    }
  }

  // === HEALTH ===
  if (url === '/health') {
    const data = await readData();
    res.json({
      status: 'ok', storage: 'vercel-kv',
      appointments: (data.appointments || []).length,
      clients: (data.clients || []).length,
      services: (data.services || []).length,
      employees: (data.employees || []).length,
      products: (data.products||[]).length,
      projects: (data.projects||[]).length,
      lastModified: data.lastModified
    });
    return;
  }

  // === DEBUG ===
  if (url === '/debug') {
    const data = await readData();
    const appts = (data.appointments || []).filter(a => !a._deleted);
    res.setHeader('Content-Type', 'text/html');
    res.send(`<pre>
Appointments: ${appts.length}
Clients: ${(data.clients||[]).length}
${appts.map(a => JSON.stringify(a, null, 2)).join('\n---\n')}
</pre>`);
    return;
  }

  // === API: SLOTS ===
  if (url === '/api/slots') {
    const data = await readData();
    const q = new URLSearchParams(req.url.split('?')[1]||'');
    const date = q.get('date');
    const serviceIdsParam = q.get('serviceIds') || q.get('serviceId') || '';
    const durationParam = q.get('duration');
    if (!date || !serviceIdsParam) {
      res.status(400).json({ error: 'date and serviceId(s) required' });
      return;
    }
    const serviceIds = serviceIdsParam.split(',').filter(Boolean);
    const servicesList = (data.services||[]).filter(s => serviceIds.includes(s.id) && !s._deleted);
    const duration = parseInt(durationParam) || (servicesList.length ? calcServiceDurationWithBlocks(servicesList, data.settings || {}) : 30);
    const employeesList = (data.employees||[]).filter(e => !e._deleted);
    const appts = (data.appointments||[]).filter(a => a.date === date && !a._deleted);
    const now = new Date();
    const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const isToday = date === todayLocal.toISOString().split('T')[0];
    const currentHour = now.getHours() + now.getMinutes() / 60;
    const dayHours = getOpeningHoursForDay(date, data.settings);
    if (dayHours.closed) {
      res.json({ slots: [], date, serviceIds: serviceIds, duration, closed: true });
      return;
    }
    const BUSINESS_START = dayHours.open, BUSINESS_END = dayHours.close, SLOT_INTERVAL = 15;
    const slots = [];
    const availableEmps = employeesList.length ? employeesList : [{ id: '', name: 'Sin asignar' }];
    availableEmps.forEach(emp => {
      const empAppts = appts.filter(a => !a.employeeId || a.employeeId === emp.id);
      const allTimes = new Set();
      for (let h = Math.floor(BUSINESS_START); h < Math.ceil(BUSINESS_END); h++) {
        const startMin = (h === Math.floor(BUSINESS_START)) ? Math.round((BUSINESS_START - Math.floor(BUSINESS_START)) * 60) : 0;
        const endMin = (h === Math.ceil(BUSINESS_END) - 1) ? Math.round((BUSINESS_END - Math.floor(BUSINESS_END)) * 60) : 60;
        for (let m = startMin; m < endMin; m += SLOT_INTERVAL) allTimes.add(h * 60 + m);
      }
      empAppts.forEach(a => {
        const t = parseTime(a.time);
        const mins = Math.round(t * 60);
        if (mins >= BUSINESS_START * 60 && mins < BUSINESS_END * 60) allTimes.add(mins);
      });
      const sortedMins = [...allTimes].sort((a, b) => a - b);
      sortedMins.forEach(totalMins => {
        const h = Math.floor(totalMins / 60);
        const m = totalMins % 60;
        const start = h + m / 60;
        const end = start + duration / 60;
        if (end > BUSINESS_END) return;
        if (isToday && start < currentHour) return;
        const timeStr = String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
        const occupied = empAppts.some(a => {
          const aStart = parseTime(a.time);
          let aDur = 30;
          if (a.endTime) {
            aDur = Math.round((parseTime(a.endTime) - aStart) * 60);
          } else if (a.apptBlocks) {
            const blocks = a.apptBlocks;
            const b1 = blocks.filter(b => b.type === 'bloque1');
            const b2 = blocks.filter(b => b.type === 'bloque2');
            const gap = (data.settings && data.settings.bloques && data.settings.bloques.bloqueGap) || 45;
            aDur = b1.reduce((s, b) => s + b.duration, 0) + (b2.length && b1.length ? gap : 0) + b2.reduce((s, b) => s + b.duration, 0);
          } else {
            const srv = (data.services||[]).find(s => s.id === a.serviceId);
            aDur = srv ? (srv.duration || 30) : 30;
          }
          const aEnd = aStart + aDur / 60;
          return start < aEnd && end > aStart;
        });
        slots.push({ time: timeStr, employeeId: emp.id, employeeName: emp.name || '', available: !occupied });
      });
    });
    slots.sort((a,b) => a.time.localeCompare(b.time) || a.employeeName.localeCompare(b.employeeName));
    res.json({ slots, date, serviceIds: serviceIds, duration });
    return;
  }

  // === API: BOOK ===
  if (url === '/api/book' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      const data = await readData();
      const serviceIds = b.serviceIds || (b.serviceId ? [b.serviceId] : []);
      if (!serviceIds.length || !b.date || !b.time || !b.clientName || !b.clientPhone) {
        res.status(400).json({ error: 'Faltan campos obligatorios' });
        return;
      }
      let client = (data.clients||[]).find(c => normPhone(c.phone) === normPhone(b.clientPhone) && !c._deleted);
      if (!client) {
        client = {
          id: 'c'+Date.now().toString(36)+Math.random().toString(36).substr(2,4),
          name: (b.clientName||'')+' (Online)', phone: b.clientPhone, email: b.clientEmail||'',
          address: '', city: '', province: '', zip: '', nif: '', notes: '',
          historialTecnico: '', punctuality: '',
          visits: 0, totalSpent: 0, created: new Date().toISOString(),
          _modified: Date.now(), _deleted: false
        };
        data.clients.push(client);
      } else if (b.clientName && client.name !== b.clientName && client.name !== b.clientName+' (Online)') {
        client.name = b.clientName;
        client._modified = Date.now();
      }
      const empId = b.employeeId || '';
      const empAppts = (data.appointments||[]).filter(a => a.date === b.date && !a._deleted && (!empId || a.employeeId === empId || !a.employeeId));
      const svcs = (data.services||[]).filter(s => serviceIds.includes(s.id));
      const totalDuration = svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
      const reqStart = parseTime(b.time);
      const reqEnd = reqStart + totalDuration / 60;
      const conflict = empAppts.find(a => {
        const as = (data.services||[]).find(s => s.id === a.serviceId);
        const aStart = parseTime(a.time);
        const aEnd = aStart + (as ? (as.duration || 30) : 30) / 60;
        return reqStart < aEnd && reqEnd > aStart;
      });
      if (conflict) {
        const cli = (data.clients||[]).find(c => c.id === conflict.clientId);
        res.status(409).json({ error: 'Este horario ya no está disponible. '+cli?.name+' tiene cita de '+conflict.time+' a '+(conflict.endTime||'') });
        return;
      }
      const reqEndH = Math.floor(reqEnd);
      const reqEndM = Math.round((reqEnd - reqEndH) * 60);
      const endTime = String(reqEndH).padStart(2,'0')+':'+String(reqEndM).padStart(2,'0');
      const appt = {
        id: 'a'+Date.now().toString(36)+Math.random().toString(36).substr(2,4),
        clientId: client.id, serviceIds: serviceIds, serviceId: serviceIds[0],
        employeeId: empId, date: b.date, time: b.time, endTime: endTime,
        notes: b.notes || 'Reserva online',
        source: 'online', status: 'pending', _modified: Date.now(), _deleted: false,
        modificationCount: 0, salonModified: false, cancelledBy: ''
      };
      data.appointments.push(appt);
      const beforeClean = (data.appointments||[]).filter(a => a.cancelledBy === 'salon' && a.clientId === client.id).length;
      (data.appointments||[]).forEach(a => {
        if (a.cancelledBy === 'salon' && a.clientId === client.id) {
          a._deleted = true; delete a.cancelledBy; a._modified = Date.now();
        }
      });
      const cleanedCount = beforeClean;
      await writeData(data);
      const emp = (data.employees||[]).find(e => e.id === b.employeeId);
      sendConfirmationEmail(b.clientEmail, b.clientName, b.date, b.time, svcs.map(s=>s.name).join(', '), emp ? emp.name : '', b.notes);
      res.json({ ok: true, appointmentId: appt.id, emailSent: !!(transporter && b.clientEmail), cleanedCount });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }

  // === API: CLIENT ===
  if (url === '/api/client') {
    if (req.method === 'GET') {
      const phone = (new URL(req.url, 'http://x')).searchParams.get('phone');
      if (!phone) {
        res.status(400).json({ error: 'phone required' });
        return;
      }
      await handleClientLogin(phone, res);
      return;
    }
    if (req.method === 'POST') {
      try {
        const b = await getBody(req);
        if (!b.name || !b.phone) {
          res.status(400).json({ error: 'name and phone required' });
          return;
        }
        const d = await readData();
        if ((d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted)) {
          res.status(409).json({ error: 'Ya existe un cliente con ese teléfono' });
          return;
        }
        const client = {
          id: 'c'+Date.now().toString(36)+Math.random().toString(36).substr(2,4),
          name: (b.name||'')+' (Online)', phone: b.phone, email: b.email||'',
          address: '', city: '', province: '', zip: '', nif: '', notes: '',
          historialTecnico: '', punctuality: '',
          visits: 0, totalSpent: 0, created: new Date().toISOString(),
          _modified: Date.now(), _deleted: false
        };
        d.clients.push(client);
        res.json({ ok: true, client: { id: client.id, name: client.name, phone: client.phone, email: client.email, historialTecnico: client.historialTecnico, punctuality: client.punctuality } });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
      return;
    }
  }

  // === API: CANCEL ===
  if (url === '/api/cancel' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      if (!b.appointmentId || !b.phone) {
        res.status(400).json({ error: 'appointmentId and phone required' });
        return;
      }
      const d = await readData();
      const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
      if (!client) {
        res.status(403).json({ error: 'Cliente no encontrado' });
        return;
      }
      const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && (!a._deleted || a.cancelledBy === 'salon'));
      if (!appt) {
        res.status(404).json({ error: 'Cita no encontrada' });
        return;
      }
      if (appt.source !== 'online') {
        res.status(403).json({ error: 'Solo puedes cancelar citas creadas online' });
        return;
      }
      if (appt.date < new Date().toISOString().split('T')[0]) {
        res.status(400).json({ error: 'No puedes cancelar una cita pasada' });
        return;
      }
      if (appt.cancelledBy === 'salon') {
        appt._deleted = true;
        appt.cancelledBy = '';
        appt._modified = Date.now();
      } else {
        appt._deleted = true;
        appt._modified = Date.now();
        appt.cancelledBy = 'client';
        appt.notes = (appt.notes||'') + ' [Cancelada por cliente]';
      }
      await writeData(d);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }

  // === API: ACCEPT MODIFICATION ===
  if (url === '/api/accept-modification' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      if (!b.appointmentId || !b.phone) {
        res.status(400).json({ error: 'appointmentId and phone required' });
        return;
      }
      const d = await readData();
      const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
      if (!client) {
        res.status(403).json({ error: 'Cliente no encontrado' });
        return;
      }
      const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && !a._deleted);
      if (!appt) {
        res.status(404).json({ error: 'Cita no encontrada' });
        return;
      }
      if (appt.source !== 'online') {
        res.status(403).json({ error: 'Solo puedes aceptar modificaciones de citas online' });
        return;
      }
      if (!appt.salonModified) {
        res.status(400).json({ error: 'La cita no tiene modificaciones pendientes' });
        return;
      }
      appt.salonModified = false;
      appt._modified = Date.now();
      await writeData(d);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }

  // === API: MODIFY ===
  if (url === '/api/modify' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      if (!b.appointmentId || !b.phone || !b.newTime) {
        res.status(400).json({ error: 'appointmentId, phone, newTime required' });
        return;
      }
      const d = await readData();
      const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
      if (!client) {
        res.status(403).json({ error: 'Cliente no encontrado' });
        return;
      }
      const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && !a._deleted);
      if (!appt) {
        res.status(404).json({ error: 'Cita no encontrada' });
        return;
      }
      if (appt.source !== 'online') {
        res.status(403).json({ error: 'Solo puedes modificar citas creadas online' });
        return;
      }
      const newDate = b.newDate || appt.date;
      const newEmpId = b.newEmployeeId !== undefined ? b.newEmployeeId : appt.employeeId;
      const newSvcId = b.newServiceId || appt.serviceId;
      const srv = (d.services||[]).find(s => s.id === newSvcId);
      const srvDuration = srv ? srv.duration : 30;
      const reqStart = parseTime(b.newTime);
      const reqEnd = reqStart + srvDuration / 60;
      const conflict = (d.appointments||[]).some(a => a.id !== appt.id && !a._deleted && a.date === newDate && (!a.employeeId || a.employeeId === (newEmpId||'')) && (() => {
        const as = (d.services||[]).find(s => s.id === a.serviceId);
        const aStart = parseTime(a.time);
        const aEnd = aStart + (as ? (as.duration || 30) : 30) / 60;
        return reqStart < aEnd && reqEnd > aStart;
      })());
      if (conflict) {
        res.status(409).json({ error: 'El nuevo horario no está disponible' });
        return;
      }
      if ((appt.modificationCount || 0) >= 1) {
        res.status(403).json({ error: 'Ya has modificado esta cita anteriormente. Solo puedes modificarla una vez.' });
        return;
      }
      appt.modificationCount = (appt.modificationCount || 0) + 1;
      appt.clientModified = true;
      appt.pendingDate = newDate;
      appt.pendingTime = b.newTime;
      appt.pendingEmployeeId = newEmpId;
      appt._modified = Date.now();
      appt.notes = (appt.notes||'') + ' [Modificada por cliente - pendiente]';
      await writeData(d);
      res.json({ ok: true, appointment: { id: appt.id, pendingDate: appt.pendingDate, pendingTime: appt.pendingTime } });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }

  // === API: ACCEPT CLIENT MODIFICATION ===
  if (url === '/api/accept-client-modification' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      if (!b.appointmentId || !b.phone) {
        res.status(400).json({ error: 'appointmentId and phone required' });
        return;
      }
      const d = await readData();
      const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
      if (!client) {
        res.status(403).json({ error: 'Cliente no encontrado' });
        return;
      }
      const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && !a._deleted);
      if (!appt) {
        res.status(404).json({ error: 'Cita no encontrada' });
        return;
      }
      if (!appt.clientModified) {
        res.status(400).json({ error: 'La cita no tiene modificaciones pendientes del cliente' });
        return;
      }
      if (b.action === 'accept') {
        appt.date = appt.pendingDate || appt.date;
        appt.time = appt.pendingTime || appt.time;
        const srv = (d.services||[]).find(s => s.id === appt.serviceId);
        const dur = srv ? srv.duration : 30;
        const reqStart = parseTime(appt.time);
        const reqEnd = reqStart + dur / 60;
        const newEndH = Math.floor(reqEnd);
        const newEndM = Math.round((reqEnd - newEndH) * 60);
        appt.endTime = String(newEndH).padStart(2,'0')+':'+String(newEndM).padStart(2,'0');
        appt.employeeId = appt.pendingEmployeeId || appt.employeeId;
        appt.notes = (appt.notes||'') + ' [Modificación aceptada por el salón]';
      } else {
        appt.notes = (appt.notes||'') + ' [Modificación rechazada por el salón]';
      }
      appt.clientModified = false;
      delete appt.pendingDate;
      delete appt.pendingTime;
      delete appt.pendingEmployeeId;
      appt._modified = Date.now();
      await writeData(d);
      res.json({ ok: true, appointment: { id: appt.id, date: appt.date, time: appt.time } });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }

  // === API: WEB PRODUCTS ===
  if (url === '/api/web-products' && req.method === 'GET') {
    if (!requireWebAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const d = await readData();
    const webProducts = (d.products||[]).filter(p => (p.showOnWeb || p.showWeb));
    const body = JSON.stringify(webProducts.map(p => ({
      id: p.id, name: p.name || '', price: p.price,
      description: p.description||'', photo: sanitizeUrl(p.photo)
    })));
    const etag = computeETag(body);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(body);
    return;
  }

  // === API: WEB OFFERS ===
  if (url === '/api/web-offers' && req.method === 'GET') {
    if (!requireWebAuth(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const d = await readData();
    const webOffers = (d.projects||[]).filter(p => (p.showOnWeb || p.showWeb));
    const svcMap = {}; (d.services||[]).forEach(s => svcMap[s.id] = s);
    const prodMap = {}; (d.products||[]).forEach(p => prodMap[p.id] = p);
    const payload = webOffers.map(p => {
      const serviceTotal = (p.services||[]).reduce((sum, sid) => { const price = svcMap[sid]?.price || 0; return sum + price; }, 0);
      const productTotal = (p.products||[]).reduce((sum, pid) => { const price = prodMap[pid]?.price || 0; return sum + price; }, 0);
      const subtotal = serviceTotal + productTotal;
      const discount = p.discount || 0;
      const totalPrice = subtotal * (1 - discount / 100);
      return {
        id: p.id, name: p.name||'',
        services: (p.services||[]).map(sid => svcMap[sid] ? svcMap[sid].name : null).filter(Boolean),
        products: (p.products||[]).map(pid => prodMap[pid] ? prodMap[pid].name : null).filter(Boolean),
        discount: p.discount||0, description: p.description||'',
        photo: sanitizeUrl(p.photo), totalPrice: Math.round(totalPrice * 100) / 100
      };
    });
    const body = JSON.stringify(payload);
    const etag = computeETag(body);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(body);
    return;
  }

  // === API: SYNC PULL ===
  if (url === '/api/sync-pull' && req.method === 'POST') {
    res.json({ ok: true, message: 'Sync pull triggered (Vercel)' });
    return;
  }

  // === API: ONLINE STATUS ===
  if (url === '/api/online-status' && req.method === 'GET') {
    const d = await readData();
    const s = d.settings || {};
    const today = new Date().toISOString().split('T')[0];
    const dayCfg = (s.onlineOpening || {})[today] || {};
    if (dayCfg.time === undefined && dayCfg.enabled === undefined) {
      const oh = getOpeningHoursForDay(today, s);
      res.json({
        enabled: !oh.closed,
        openingTime: oh.open < 10 ? '0'+Math.floor(oh.open)+':00' : Math.floor(oh.open)+':00',
        settings: s
      });
    } else {
      res.json({
        enabled: dayCfg.enabled !== false,
        openingTime: dayCfg.time || '18:00',
        settings: s
      });
    }
    return;
  }

  // === API: DEBUG ===
  if (url === '/api/debug' && req.method === 'GET') {
    const d = await readData();
    res.json({
      clients: (d.clients||[]).filter(c => !c._deleted).length,
      totalClients: (d.clients||[]).length,
      services: (d.services||[]).filter(s => !s._deleted).length,
      employees: (d.employees||[]).filter(e => !e._deleted).length,
      appointments: (d.appointments||[]).filter(a => !a._deleted).length
    });
    return;
  }

  // === API: AI MESSAGE (WhatsApp Bridge - Baileys) ===
  if (url === '/api/ai-message' && req.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { phone, text } = JSON.parse(raw);
      let replyText = '';
      if (phone && text) {
        const { processWhatsAppMessage } = require('../lib/ai-assistant');
        replyText = await processWhatsAppMessage(phone, text) || '';
      }
      res.status(200).json({ response: replyText });
    } catch (e) {
      console.error('[AI MESSAGE ERROR]', e.message);
      res.status(200).json({ response: 'Lo siento, hubo un error.' });
    }
    return;
  }

  // === API: WHATSAPP WEBHOOK (Twilio) ===
  if (url === '/api/whatsapp-webhook' && req.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const params = new URLSearchParams(raw);
      const from = params.get('From') || '';
      const body = params.get('Body') || '';
      const phone = from.replace('whatsapp:', '').trim();

      let replyText = '';
      if (phone && body) {
        const { processWhatsAppMessage } = require('../lib/ai-assistant');
        replyText = await processWhatsAppMessage(phone, body) || '';
      }

      res.setHeader('Content-Type', 'text/xml');
      res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(replyText)}</Message></Response>`);
    } catch (e) {
      console.error('[TWILIO WHATSAPP ERROR]', e.message);
      res.setHeader('Content-Type', 'text/xml');
      res.status(200).send('<Response></Response>');
    }
    return;
  }

  // === API: PHONE INCOMING (Twilio call start) ===
  if (url === '/api/phone-incoming' && req.method === 'POST') {
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/phone-process" method="POST" language="es-ES" speechTimeout="auto">
    <Say voice="alice" language="es-ES">Hola, bienvenido a ${BUSINESS_NAME}. Soy Sara, tu asistente virtual. ¿En qué puedo ayudarte hoy?</Say>
  </Gather>
  <Say voice="alice" language="es-ES">Parece que no me has dicho nada. Si necesitas ayuda, vuelve a llamarnos. ¡Adiós!</Say>
</Response>`);
    return;
  }

  // === API: PHONE AI PROCESS (Twilio speech result) ===
  if (url === '/api/phone-process' && req.method === 'POST') {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const params = new URLSearchParams(raw);
      const speechResult = params.get('SpeechResult') || '';
      const caller = params.get('From') || '';
      console.log(`[VOICE 2 IN] ${caller}: ${speechResult}`);

      if (!speechResult) {
        res.setHeader('Content-Type', 'text/xml');
        res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/phone-process" method="POST" language="es-ES" speechTimeout="auto">
    <Say voice="alice" language="es-ES">No te he entendido bien. ¿Podrías repetirlo, por favor?</Say>
  </Gather>
  <Say voice="alice" language="es-ES">Lo siento, tengo problemas para escucharte. Puedes intentar llamarnos más tarde o escribirnos por WhatsApp. ¡Hasta pronto!</Say>
</Response>`);
        return;
      }

      const { processPhoneMessage } = require('../lib/ai-assistant');
      const responseText = await processPhoneMessage(caller, speechResult);

      res.setHeader('Content-Type', 'text/xml');
      res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/phone-process" method="POST" language="es-ES" speechTimeout="auto">
    <Say voice="alice" language="es-ES">${escapeXml(responseText)}</Say>
  </Gather>
  <Say voice="alice" language="es-ES">Si no tienes más dudas, gracias por llamar a ${BUSINESS_NAME}. ¡Que tengas un buen día!</Say>
</Response>`);
    } catch (e) {
      console.error('[PHONE PROCESS ERROR]', e.message);
      res.setHeader('Content-Type', 'text/xml');
      res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Google.es-ES-Standard-A" language="es-ES">Lo siento, ha surgido un problema técnico inesperado. Por favor, llámanos directamente al ${BUSINESS_PHONE}.</Say></Response>`);
    }
    return;
  }

  // === WEBHOOK TESTER (browser UI) ===
  if (url === '/api/whatsapp-test' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagnóstico WhatsApp IA</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#f5f5f5;padding:20px;max-width:800px;margin:auto}
h1{font-size:20px;color:#6C3483;margin-bottom:16px}
.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.card h2{font-size:14px;color:#666;margin-bottom:8px}
pre{font-size:12px;background:#f8f8f8;padding:12px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.chat{border:1px solid #e0e0e0;border-radius:12px;height:300px;overflow-y:auto;padding:12px;margin-bottom:8px;background:#fafafa}
.msg{margin:8px 0;padding:10px 14px;border-radius:18px;max-width:80%;font-size:14px;line-height:1.4}
.msg.user{background:#6C3483;color:#fff;margin-left:auto;border-radius:18px 18px 4px 18px}
.msg.bot{background:#e8e8e8;color:#333;margin-right:auto;border-radius:18px 18px 18px 4px}
.msg.error{background:#ffe0e0;color:#c00;margin-right:auto}
.chat-input{display:flex;gap:8px}.chat-input input{flex:1;padding:10px 14px;border:1px solid #ddd;border-radius:24px;font-size:14px;outline:none}
.chat-input input:focus{border-color:#6C3483}.chat-input button{padding:10px 20px;background:#6C3483;color:#fff;border:none;border-radius:24px;cursor:pointer;font-size:14px}
.chat-input button:hover{background:#5a2d6e}.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;margin-left:6px}
.badge.ok{background:#d4edda;color:#155724}.badge.warn{background:#fff3cd;color:#856404}.badge.err{background:#f8d7da;color:#721c24}
.status-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px}.status-item{padding:8px;border-radius:8px;background:#f8f8f8}
.status-label{color:#888;font-size:11px}.status-value{font-weight:600;margin-top:2px}
</style></head><body>
<h1>🔍 Diagnóstico WhatsApp IA</h1>

<div class="card" id="debugCard"><h2>Estado del sistema</h2><pre id="debugPre">Cargando...</pre></div>

<div class="card">
  <h2>🧪 Probar asistente IA (simula lo que recibe Twilio)</h2>
  <div class="chat" id="chatBox">
    <div class="msg bot">Hola, soy Sara. ¿Qué necesitas? Las respuestas se generan con Groq IA.</div>
  </div>
  <div class="chat-input">
    <input type="text" id="msgInput" placeholder="Escribe un mensaje..." onkeydown="if(event.key==='Enter')sendTest()">
    <button onclick="sendTest()">Enviar</button>
  </div>
</div>

<div class="card">
  <h2>📤 Probar envío por Twilio</h2>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <input type="text" id="testPhone" placeholder="Teléfono (ej. 34624143658)" style="flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px">
    <input type="text" id="testText" placeholder="Texto del mensaje" style="flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px">
    <button onclick="sendTwilio()" style="padding:10px 20px;background:#25D366;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Enviar</button>
  </div>
  <pre id="twilioResult" style="margin-top:8px;font-size:12px"></pre>
</div>

<script>
async function loadDebug(){
  const r=await fetch('/api/debug');
  const d=await r.json();
  const gk=d.groqKeySet?'✅ Configurada':'❌ No configurada o placeholder';
  const tw=d.twilio;
  const twStatus=tw.error?'<span class="badge err">Error: '+tw.error+'</span>':(tw.status?'<span class="badge ok">'+tw.status+'</span>':'<span class="badge warn">Sin datos</span>');
  const twBal=tw.error?'-':(tw.balance||'?')+' '+(tw.currency||'');
  const lastMsg=tw.lastMessage?tw.lastMessage.status+' ('+tw.lastMessage.direction+')':'Ninguno';
  document.getElementById('debugPre').innerHTML=
    'WhatsApp Twilio:   '+(d.whatsappNumber||'(empty)')+'\\n'+
    'Teléfono negocio:  '+(d.businessPhone||'(empty)')+'\\n'+
    'Groq API Key:      '+gk+'\\n'+
    'Twilio estado:     '+twStatus+'\\n'+
    'Twilio saldo:      '+twBal+'\\n'+
    'Último mensaje:    '+lastMsg+(d.twilio?.lastMessage?.errorCode?' (err: '+d.twilio.lastMessage.errorCode+')':'');
}
loadDebug();

async function sendTest(){
  const txt=document.getElementById('msgInput').value.trim();
  if(!txt)return;
  const chat=document.getElementById('chatBox');
  chat.innerHTML+='<div class="msg user">'+escHtml(txt)+'</div>';
  document.getElementById('msgInput').value='';
  chat.scrollTop=chat.scrollHeight;
  chat.innerHTML+='<div class="msg bot" style="color:#999" id="waitMsg">Escribiendo...</div>';
  chat.scrollTop=chat.scrollHeight;
  try{
    const r=await fetch('/api/ai-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:'34600000000',text:txt})});
    const d=await r.json();
    document.getElementById('waitMsg')?.remove();
    const reply=d.response||'(Respuesta vacía)';
    chat.innerHTML+='<div class="msg bot">'+escHtml(reply)+'</div>';
  }catch(e){
    document.getElementById('waitMsg')?.remove();
    chat.innerHTML+='<div class="msg error">Error: '+escHtml(e.message)+'</div>';
  }
  chat.scrollTop=chat.scrollHeight;
}

async function sendTwilio(){
  const phone=document.getElementById('testPhone').value.trim()||'34624143658';
  const text=document.getElementById('testText').value.trim()||'Prueba desde diagnóstico';
  document.getElementById('twilioResult').textContent='Enviando...';
  try{
    const r=await fetch('/api/test-send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:'+'+phone,text})});
    const d=await r.json();
    document.getElementById('twilioResult').textContent=JSON.stringify(d,null,2);
  }catch(e){
    document.getElementById('twilioResult').textContent='Error: '+e.message;
  }
}

function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
</script></body></html>`);
    return;
  }

  // 404 for everything else
  res.status(404).json({ error: 'Not found' });
};

function escapeXml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
