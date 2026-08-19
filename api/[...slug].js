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

function todayMadrid() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const MIN_BOOKING_DAYS_AHEAD = 3;
function minBookingDate() {
  const d = new Date();
  d.setDate(d.getDate() + MIN_BOOKING_DAYS_AHEAD);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function isDateTooSoon(dateStr) {
  const min = minBookingDate();
  return dateStr < min;
}

function madridHour() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  return { h, m };
}

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
  if (!settings || !settings.openingHours) return { open: 9, close: 19, closed: false, breakStart: null, breakEnd: null };
  const d = new Date(dateStr + 'T12:00:00').getDay();
  const day = settings.openingHours[d] || { open: '09:00', close: '19:00', closed: false };
  const openH = parseInt(day.open) || 9;
  const closeH = parseInt(day.close) || 19;
  const openMin = parseInt((day.open || '09:00').split(':')[1]) || 0;
  const closeMin = parseInt((day.close || '19:00').split(':')[1]) || 0;
  let breakStart = null, breakEnd = null;
  if (day.breakStart && day.breakEnd) {
    const bsH = parseInt(day.breakStart) || 0;
    const bsM = parseInt((day.breakStart || '00:00').split(':')[1]) || 0;
    const beH = parseInt(day.breakEnd) || 0;
    const beM = parseInt((day.breakEnd || '00:00').split(':')[1]) || 0;
    breakStart = bsH + bsM / 60;
    breakEnd = beH + beM / 60;
  } else if (day.morningClose && day.afternoonOpen) {
    const mcH = parseInt(day.morningClose) || 0;
    const mcM = parseInt((day.morningClose || '00:00').split(':')[1]) || 0;
    const aoH = parseInt(day.afternoonOpen) || 0;
    const aoM = parseInt((day.afternoonOpen || '00:00').split(':')[1]) || 0;
    const mc = mcH + mcM / 60;
    const ao = aoH + aoM / 60;
    if (ao > mc) { breakStart = mc; breakEnd = ao; }
  }
  return {
    open: openH + openMin / 60,
    close: closeH + closeMin / 60,
    closed: day.closed === true,
    breakStart,
    breakEnd
  };
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
  const today = todayMadrid();
  const appointments = (d.appointments||[]).filter(a => a.clientId === client.id && a.date >= today && (!a._deleted || a.cancelledBy === 'client' || a.cancelledBy === 'salon')).sort((a,b) => (a.date+' '+a.time).localeCompare(b.date+' '+b.time));
  const svcMap = {}; (d.services||[]).forEach(s => svcMap[s.id] = s);
  const empMap = {}; (d.employees||[]).forEach(e => empMap[e.id] = e);
  appointments.sort((a,b) => (a.date+' '+a.time).localeCompare(b.date+' '+b.time));
  res.json({
    ok: true,
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

  // === DEBUG: check env ===
  if ((url === '/api/debug' || url === '/api/version') && req.method === 'GET') {
    res.json({
      groqKeySet: !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'tu_groq_api_key_aqui'),
      businessPhone: process.env.BUSINESS_PHONE || ''
    });
    return;
  }



  // === SYNC ===
  if (url === '/sync' || url === '/sync/' || url === '/api/sync' || url === '/api/sync/') {
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
        // Record which appointments were cancelled/deleted BEFORE merge, so TPV can't resurrect them
        const wasCancelledOrDeleted = new Set();
        (current.appointments||[]).forEach(a => { if (a && (a.cancelledBy || a._deleted)) wasCancelledOrDeleted.add(a.id); });
        ['appointments', 'clients', 'services', 'employees', 'products', 'projects', 'movements', 'sections', 'providers'].forEach(k => {
          if (Array.isArray(remote[k])) {
            merged[k] = mergeArray(Array.isArray(current[k]) ? current[k] : [], remote[k]);
          }
        });
        merged.settings = remote.settings || current.settings || {};
        // Protect against TPV resurrecting cancelled/deleted appointments
        (merged.appointments||[]).forEach(a => {
          if (a && !a.cancelledBy && !a._deleted && wasCancelledOrDeleted.has(a.id)) {
            const orig = (current.appointments||[]).find(x => x && x.id === a.id);
            if (orig) {
              // Solo restaurar la cancelacion/borrado si la version entrante NO es una
              // reactivacion mas reciente (con _modified mayor): una cita reactivada en
              // Access/TPV no debe volver a borrarse por una copia desactualizada.
              if ((a._modified || 0) <= (orig._modified || 0)) {
                if (orig.cancelledBy) a.cancelledBy = orig.cancelledBy;
                if (orig._deleted) a._deleted = true;
                if (orig.cancelledBy || orig._deleted) a._modified = Date.now();
              }
            }
          }
        });
        // Auto-clean: keep only today+future appointments in cloud (past stored in local sync-helper only)
        const today = todayMadrid();
        (merged.appointments||[]).forEach(a => {
          if (a.cancelledBy === 'salon' && (a.date < today || a.source !== 'online')) {
            a._deleted = true; delete a.cancelledBy; a._modified = Date.now();
          }
        });
        merged.appointments = (merged.appointments||[]).filter(a => a.date >= today);
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
  if (url === '/health' || url === '/api/health') {
    const data = await readData();
    res.json({
      status: 'ok', storage: 'upstash-redis',
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



  // === API: SLOTS ===
  if (url === '/api/slots') {
    const data = await readData();
    const q = new URLSearchParams(req.url.split('?')[1]||'');
    const date = q.get('date');
    const serviceIdsParam = q.get('serviceIds') || q.get('serviceId') || '';
    if (!date || !serviceIdsParam) {
      res.status(400).json({ error: 'date and serviceId(s) required' });
      return;
    }
    if (isDateTooSoon(date)) {
      res.status(400).json({ error: 'Solo se pueden reservar citas con un mínimo de '+MIN_BOOKING_DAYS_AHEAD+' días de antelación.' });
      return;
    }
    const serviceIds = serviceIdsParam.split(',').filter(Boolean);
    const servicesList = (data.services||[]).filter(s => serviceIds.includes(s.id) && !s._deleted);
    const gap = (data.settings && data.settings.bloques && data.settings.bloques.bloqueGap) || 45;
    const bloque1Svcs = servicesList.filter(s => s.bloque === 'bloque1' || !s.bloque);
    const bloque2Svcs = servicesList.filter(s => s.bloque === 'bloque2');
    const hasBlocks = bloque1Svcs.length && bloque2Svcs.length;
    const bloque1Dur = bloque1Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
    const bloque2Dur = bloque2Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
    const totalDuration = hasBlocks ? bloque1Dur + gap + bloque2Dur : bloque1Dur + bloque2Dur;
    const employeesList = (data.employees||[]).filter(e => !e._deleted);
    const appts = (data.appointments||[]).filter(a => a.date === date && !a._deleted && !a.cancelledBy);
    const now = new Date();
    const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const isToday = date === todayLocal.toISOString().split('T')[0];
    const currentHour = now.getHours() + now.getMinutes() / 60;
    const dayHours = getOpeningHoursForDay(date, data.settings);
    if (dayHours.closed) {
      res.json({ slots: [], date, serviceIds, duration: totalDuration, closed: true });
      return;
    }
    const BUSINESS_START = dayHours.open, BUSINESS_END = dayHours.close, SLOT_INTERVAL = 15;
    const BREAK_START = dayHours.breakStart, BREAK_END = dayHours.breakEnd;
    const isInBreak = (t) => BREAK_START !== null && BREAK_END !== null && t >= BREAK_START && t < BREAK_END;
    const rangeOccupied = (empAppts, rangeStart, rangeEnd) => {
      return empAppts.some(a => {
        const aS = parseTime(a.time);
        let aE;
        if (a.endTime) {
          aE = parseTime(a.endTime);
        } else if (a.apptBlocks) {
          const blocks = a.apptBlocks;
          const b1 = blocks.filter(b => b.type === 'bloque1');
          const b2 = blocks.filter(b => b.type === 'bloque2');
          const aGap = (data.settings && data.settings.bloques && data.settings.bloques.bloqueGap) || 45;
          const b1d = b1.reduce((s, b) => s + b.duration, 0);
          const b2d = b2.reduce((s, b) => s + b.duration, 0);
          aE = aS + (b1d + (b2.length && b1.length ? aGap : 0) + b2d) / 60;
        } else {
          const srv = (data.services||[]).find(s => s.id === a.serviceId);
          aE = aS + (srv ? (srv.duration || 30) : 30) / 60;
        }
        return rangeStart < aE && rangeEnd > aS;
      });
    };
    const slots = [];
    const availableEmps = employeesList.length ? employeesList : [{ id: '', name: 'Sin asignar' }];
    availableEmps.forEach(emp => {
      const empAppts = appts.filter(a => !a.employeeId || a.employeeId === emp.id);
      const allTimes = new Set();
      for (let h = Math.floor(BUSINESS_START); h < Math.ceil(BUSINESS_END); h++) {
        const startMin = (h === Math.floor(BUSINESS_START)) ? Math.round((BUSINESS_START - Math.floor(BUSINESS_START)) * 60) : 0;
        const endMin = (h === Math.ceil(BUSINESS_END) - 1) ? Math.round((BUSINESS_END - Math.floor(BUSINESS_END)) * 60) : 60;
        for (let m = startMin; m < endMin; m += SLOT_INTERVAL) {
          const slotH = h + m / 60;
          if (!isInBreak(slotH)) allTimes.add(h * 60 + m);
        }
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
        const timeStr = String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
        if (isToday && start < currentHour) return;
        if (isInBreak(start)) return;
        if (hasBlocks) {
          const b1Start = start, b1End = b1Start + bloque1Dur / 60;
          const b2Start = b1End + gap / 60, b2End = b2Start + bloque2Dur / 60;
          if (b2End > BUSINESS_END) return;
          if (isInBreak(b1Start) || isInBreak(b1End) || isInBreak(b2Start) || isInBreak(b2End)) return;
          const b1Occ = rangeOccupied(empAppts, b1Start, b1End);
          const b2Occ = rangeOccupied(empAppts, b2Start, b2End);
          slots.push({ time: timeStr, employeeId: emp.id, employeeName: emp.name || '', available: !b1Occ && !b2Occ });
        } else {
          const end = start + totalDuration / 60;
          if (end > BUSINESS_END) return;
          if (BREAK_START !== null && BREAK_END !== null && start < BREAK_END && end > BREAK_START) return;
          const occupied = rangeOccupied(empAppts, start, end);
          slots.push({ time: timeStr, employeeId: emp.id, employeeName: emp.name || '', available: !occupied });
        }
      });
    });
    slots.sort((a,b) => a.time.localeCompare(b.time) || a.employeeName.localeCompare(b.employeeName));
    res.json({ slots, date, serviceIds, duration: totalDuration });
    return;
  }

  // === API: BOOK ===
  if (url === '/api/book' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      const data = await readData();
      const webToday = todayMadrid();
      const webCfg = ((data.settings||{}).onlineOpening||{})[webToday] || {};
      let webEnabled = webCfg.enabled === true;
      if (webCfg.time) {
        const [th, tm] = webCfg.time.split(':').map(Number);
        const { h, m } = madridHour();
        const pastTime = h > th || (h === th && m >= tm);
        if (!webEnabled && pastTime) webEnabled = true;
        if (webEnabled && !pastTime) webEnabled = false;
      }
      if (!webEnabled) {
        res.status(409).json({ error: 'Las reservas online están cerradas en este momento.' });
        return;
      }
      const dayCfg = ((data.settings||{}).onlineOpening||{})[b.date] || {};
      if (dayCfg.enabled === false) {
        res.status(409).json({ error: 'Las reservas online están cerradas para ese día.' });
        return;
      }
      const serviceIds = b.serviceIds || (b.serviceId ? [b.serviceId] : []);
      if (!serviceIds.length || !b.date || !b.time || !b.clientName || !b.clientPhone) {
        res.status(400).json({ error: 'Faltan campos obligatorios' });
        return;
      }
      if (isDateTooSoon(b.date)) {
        res.status(400).json({ error: 'Solo se pueden reservar citas con un mínimo de '+MIN_BOOKING_DAYS_AHEAD+' días de antelación.' });
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
      const svcs = (data.services||[]).filter(s => serviceIds.includes(s.id));
      const bloque1Svcs = svcs.filter(s => s.bloque === 'bloque1' || !s.bloque);
      const bloque2Svcs = svcs.filter(s => s.bloque === 'bloque2');
      const hasBlocks = bloque1Svcs.length && bloque2Svcs.length;
      const gap = (data.settings && data.settings.bloques && data.settings.bloques.bloqueGap) || 45;
      const makeBlockAppts = (startTime) => {
        const mkAppt = (time, services, blockNum, blockGroupId) => {
          const dur = services.reduce((sum, s) => sum + (s.duration || 30), 0);
          const totalMin = Math.round(parseTime(time) * 60) + dur;
          const endH = Math.floor(totalMin / 60);
          const endM = totalMin % 60;
          const endTime = String(endH).padStart(2,'0')+':'+String(endM).padStart(2,'0');
          return {
            id: 'a'+Date.now().toString(36)+Math.random().toString(36).substr(2,4),
            clientId: client.id,
            serviceId: services.length === 1 ? services[0].id : '',
            serviceIds: services.map(s => s.id),
            employeeId: empId, date: b.date, time, endTime,
            notes: b.notes || 'Reserva online',
            source: 'online', status: 'pending', pendingSalonConfirm: true, _modified: Date.now(), _deleted: false,
            modificationCount: 0, salonModified: false, cancelledBy: '',
            blockGroupId, blockNum
          };
        };
        const appts = [];
        const blockGroupId = 'bg'+Date.now().toString(36)+Math.random().toString(36).substr(2,4);
        const b1 = mkAppt(startTime, bloque1Svcs, '1', blockGroupId);
        appts.push(b1);
        if (bloque2Svcs.length) {
          const b2StartMin = Math.round(parseTime(startTime) * 60) + bloque1Svcs.reduce((sum, s) => sum + (s.duration || 30), 0) + gap;
          const b2Start = String(Math.floor(b2StartMin / 60)).padStart(2,'0')+':'+String(b2StartMin % 60).padStart(2,'0');
          const b2 = mkAppt(b2Start, bloque2Svcs, '2', blockGroupId);
          appts.push(b2);
        }
        return appts;
      };
      const getBlockHours = (block) => {
        if (block.endTime) {
          return { s: parseTime(block.time), e: parseTime(block.endTime) };
        }
        const dur = (block.serviceIds||[]).reduce((sum, id) => { const s = svcs.find(x => x.id === id); return sum + (s ? (s.duration || 30) : 30); }, 0);
        return { s: parseTime(block.time), e: parseTime(block.time) + dur / 60 };
      };
      const empAppts = (data.appointments||[]).filter(a => a.date === b.date && !a._deleted && !a.cancelledBy && (!empId || a.employeeId === empId || !a.employeeId));
      const bkHours = getOpeningHoursForDay(b.date, data.settings);
      if (bkHours.breakStart !== null && bkHours.breakEnd !== null) {
        const bkReqStart = parseTime(b.time);
        const bkTotalDuration = svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
        const bkReqEnd = bkReqStart + bkTotalDuration / 60;
        if (bkReqStart < bkHours.breakEnd && bkReqEnd > bkHours.breakStart) {
          res.status(409).json({ error: 'Esa hora cae en el horario de descanso del mediodía. Por favor, elige otra hora.' });
          return;
        }
      }
      if (hasBlocks) {
        const newAppts = makeBlockAppts(b.time);
        for (const newAppt of newAppts) {
          const nh = getBlockHours(newAppt);
          const conflict = empAppts.find(a => {
            let aStart, aEnd;
            if (a.blockNum) {
              const gh = getBlockHours(a);
              aStart = gh.s; aEnd = gh.e;
            } else {
              aStart = parseTime(a.time);
              if (a.endTime) {
                aEnd = parseTime(a.endTime);
              } else {
                const as = (data.services||[]).find(s => s.id === a.serviceId);
                aEnd = aStart + (as ? (as.duration || 30) : 30) / 60;
              }
            }
            return nh.s < aEnd && nh.e > aStart;
          });
          if (conflict) {
            const cli = (data.clients||[]).find(c => c.id === conflict.clientId);
            res.status(409).json({ error: 'Este horario ya no está disponible. '+cli?.name+' tiene cita de '+conflict.time+' a '+(conflict.endTime||'') });
            return;
          }
          data.appointments.push(newAppt);
        }
      } else {
        const totalDuration = svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
        const reqStart = parseTime(b.time);
        const reqEnd = reqStart + totalDuration / 60;
        const conflict = empAppts.find(a => {
          let aStart, aEnd;
          if (a.blockNum) {
            const gh = getBlockHours(a);
            aStart = gh.s; aEnd = gh.e;
          } else {
            aStart = parseTime(a.time);
            if (a.endTime) {
              aEnd = parseTime(a.endTime);
            } else {
              const as = (data.services||[]).find(s => s.id === a.serviceId);
              aEnd = aStart + (as ? (as.duration || 30) : 30) / 60;
            }
          }
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
          source: 'online', status: 'pending', pendingSalonConfirm: true, _modified: Date.now(), _deleted: false,
          modificationCount: 0, salonModified: false, cancelledBy: ''
        };
        data.appointments.push(appt);
      }
      const beforeClean = (data.appointments||[]).filter(a => a.cancelledBy === 'salon' && a.clientId === client.id).length;
      (data.appointments||[]).forEach(a => {
          if (a.cancelledBy === 'salon' && a.clientId === client.id) {
          a._deleted = true; delete a.cancelledBy; a._modified = Date.now();
        }
      });
      const cleanedCount = beforeClean;
      await writeData(data);
      const emp = (data.employees||[]).find(e => e.id === b.employeeId);
      const apptTimes = [b.time];
      if (hasBlocks && bloque2Svcs.length) {
        const b1Dur = bloque1Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
        const b2StartMin = Math.round(parseTime(b.time) * 60) + b1Dur + gap;
        apptTimes.push(String(Math.floor(b2StartMin / 60)).padStart(2,'0')+':'+String(b2StartMin % 60).padStart(2,'0'));
      }
      const emailTime = apptTimes.length > 1 ? '1ª cita a las ' + apptTimes[0] + ' y 2ª a las ' + apptTimes[1] : b.time;
      sendConfirmationEmail(b.clientEmail, b.clientName, b.date, emailTime, svcs.map(s=>s.name).join(', '), emp ? emp.name : '', b.notes);
      res.json({ ok: true, appointmentId: 'ok', emailSent: !!(transporter && b.clientEmail), cleanedCount, apptTimes });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }

  const crypto = require('crypto');
  function hashPassword(pw) {
    if (!pw) return '';
    return crypto.createHash('sha256').update(String(pw) + 'tpv_salt_2026').digest('hex');
  }

  function clientHashPW(str) {
    if (!str) return '';
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h = h & h; }
    let hex = (h >>> 0).toString(16);
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); hex += (c * 9301 + 49297) % 233280; }
    return Buffer.from(hex, 'latin1').toString('base64').substring(0, 32);
  }

  function verifyPassword(inputPw, client) {
    if (!inputPw || !client) return false;
    const hash = hashPassword(inputPw);
    const legacy = clientHashPW(inputPw);
    if (client.passwordHash && (client.passwordHash === hash || client.passwordHash === legacy)) return true;
    if (client.password && client.password === inputPw) return true;
    if (client.password && hashPassword(client.password) === hash) return true;
    return false;
  }

  // === API: CLIENT LOGIN ===
  if (url === '/api/client/login' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      const searchKey = (b.email || b.phone || '').trim();
      const password = b.password || '';
      if (!searchKey || !password) {
        res.status(400).json({ error: 'Email/teléfono y contraseña obligatorios' });
        return;
      }
      const normP = normPhone(searchKey);
      const searchStr = searchKey.toLowerCase();
      const d = await readData();
      const client = (d.clients || []).find(c =>
        !c._deleted && (
          (c.phone && normPhone(c.phone) === normP) ||
          (c.email && c.email.toLowerCase() === searchStr)
        )
      );
      if (!client) {
        res.status(404).json({ error: 'No se encontró ninguna cuenta con ese email o teléfono' });
        return;
      }
      const hasPassword = !!(client.passwordHash || client.password);
      if (!hasPassword) {
        res.json({
          ok: true,
          needsProfileCompletion: true,
          client: { id: client.id, name: client.name, phone: client.phone, email: client.email || '' }
        });
        return;
      }
      if (!verifyPassword(password, client)) {
        res.status(401).json({ error: 'Email/teléfono o contraseña incorrectos' });
        return;
      }
      await handleClientLogin(client.phone, res);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }

  // === API: CLIENT COMPLETE PROFILE ===
  if (url === '/api/client/complete-profile' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      if ((!b.clientId && !b.phone) || !b.password) {
        res.status(400).json({ error: 'Teléfono y contraseña son obligatorios' });
        return;
      }
      if (b.password.length < 8) {
        res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
        return;
      }
      const d = await readData();
      const client = b.clientId
        ? (d.clients || []).find(c => c.id === b.clientId && !c._deleted)
        : (d.clients || []).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
      if (!client) {
        res.status(404).json({ error: 'Cliente no encontrado' });
        return;
      }
      if (client.passwordHash || client.password) {
        res.status(409).json({ error: 'Esta cuenta ya tiene contraseña. Usa la opción "¿Olvidaste tu contraseña?"' });
        return;
      }
      if (b.email && b.email.trim()) {
        client.email = b.email.trim();
      }
      client.passwordHash = hashPassword(b.password);
      client._modified = Date.now();
      await writeData(d);
      res.json({ ok: true, client: { id: client.id, name: client.name, phone: client.phone, email: client.email } });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }

  // === API: RECOVER PASSWORD ===
  if (url === '/api/client/recover-password' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      if (!b.email) {
        res.status(400).json({ error: 'Email obligatorio' });
        return;
      }
      const email = b.email.trim().toLowerCase();
      const d = await readData();
      const client = (d.clients || []).find(c => c.email && c.email.trim().toLowerCase() === email && !c._deleted);
      if (!client) {
        res.status(404).json({ error: 'No existe ninguna cuenta con ese email' });
        return;
      }
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      client.recoveryCode = code;
      client.recoveryExpires = Date.now() + 15 * 60 * 1000;
      client._modified = Date.now();
      await writeData(d);
      
      let emailSent = false;
      if (transporter && client.email) {
        try {
          await transporter.sendMail({
            from: process.env.SMTP_FROM || 'no-reply@nymaraestilistas.es',
            to: client.email,
            subject: 'Código de recuperación de contraseña - Reservas Online',
            text: `Tu código de recuperación es: ${code}\nEste código caduca en 15 minutos.`
          });
          emailSent = true;
        } catch(mailErr) {
          console.error('Error enviando mail de recuperación:', mailErr);
        }
      }
      if (!emailSent && process.env.RESEND_API_KEY && client.email) {
        try {
          const from = process.env.EMAIL_FROM || 'Nymara Estilistas <onboarding@resend.dev>';
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from,
              to: [client.email],
              subject: 'Código de recuperación de contraseña - Reservas Online',
              text: `Tu código de recuperación es: ${code}\nEste código caduca en 15 minutos.`
            })
          });
          emailSent = r.ok;
          if (!r.ok) console.error('Recovery email (Resend) error:', r.status, await r.text());
        } catch(resendErr) {
          console.error('Recovery email (Resend) error:', resendErr.message);
        }
      }
      res.json({ ok: true, emailSent, message: emailSent ? 'Código de recuperación enviado' : 'No se pudo enviar el email de recuperación' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }

  // === API: RESET PASSWORD ===
  if (url === '/api/client/reset-password' && req.method === 'POST') {
    try {
      const b = await getBody(req);
      if (!b.email || !b.code || !b.newPassword) {
        res.status(400).json({ error: 'Email, código y nueva contraseña obligatorios' });
        return;
      }
      if (b.newPassword.length < 8) {
        res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
        return;
      }
      const email = b.email.trim().toLowerCase();
      const d = await readData();
      const client = (d.clients || []).find(c => c.email && c.email.trim().toLowerCase() === email && !c._deleted);
      if (!client) {
        res.status(404).json({ error: 'No existe ningún cliente registrado con ese email' });
        return;
      }
      if (!client.recoveryCode || client.recoveryCode !== b.code.trim() || !client.recoveryExpires || client.recoveryExpires < Date.now()) {
        res.status(400).json({ error: 'El código de recuperación es incorrecto o ha caducado' });
        return;
      }
      client.passwordHash = hashPassword(b.newPassword);
      delete client.password;
      delete client.recoveryCode;
      delete client.recoveryExpires;
      client._modified = Date.now();
      await writeData(d);
      res.json({ ok: true, message: 'Contraseña restablecida con éxito' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
    return;
  }

  // === API: CLIENT REGISTRATION & GET ===
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
        if (!b.name || !b.phone || !b.email || !b.password) {
          res.status(400).json({ error: 'Nombre, teléfono, email y contraseña son obligatorios' });
          return;
        }
        if (b.password.length < 8) {
          res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
          return;
        }
        const d = await readData();
        const existingByPhone = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
        const existingByEmail = (d.clients||[]).find(c => c.email && c.email.toLowerCase() === b.email.trim().toLowerCase() && !c._deleted);

        if (existingByPhone || existingByEmail) {
          const existing = existingByPhone || existingByEmail;
          // If existing legacy client without password, upgrade profile
          if (!existing.passwordHash && !existing.password) {
            existing.name = b.name;
            existing.email = b.email.trim();
            existing.passwordHash = hashPassword(b.password);
            existing._modified = Date.now();
            await writeData(d);
            res.json({ ok: true, client: { id: existing.id, name: existing.name, phone: existing.phone, email: existing.email } });
            return;
          }
          res.status(409).json({ error: 'Ya existe un cliente registrado con este teléfono o email' });
          return;
        }
        const client = {
          id: 'c'+Date.now().toString(36)+Math.random().toString(36).substr(2,4),
          name: (b.name||'')+' (Online)', phone: b.phone, email: b.email.trim(),
          passwordHash: hashPassword(b.password),
          address: '', city: '', province: '', zip: '', nif: '', notes: '',
          historialTecnico: '', punctuality: '',
          visits: 0, totalSpent: 0, created: new Date().toISOString(),
          _modified: Date.now(), _deleted: false
        };
        d.clients.push(client);
        await writeData(d);
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
      if (appt.date < todayMadrid()) {
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
      if (isDateTooSoon(newDate)) {
        res.status(400).json({ error: 'Solo se pueden reservar citas con un mínimo de '+MIN_BOOKING_DAYS_AHEAD+' días de antelación.' });
        return;
      }
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
    res.json(JSON.parse(body));
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
    res.json(JSON.parse(body));
    return;
  }

  // === API: SYNC PULL ===
  if (url === '/api/sync-pull' && req.method === 'POST') {
      res.json({ ok: true, message: 'Sync pull triggered' });
    return;
  }

  // === API: ONLINE STATUS ===
  if (url === '/api/online-status' && req.method === 'GET') {
    const d = await readData();
    const s = d.settings || {};
    const today = todayMadrid();
    const dayCfg = (s.onlineOpening || {})[today] || {};
    if (dayCfg.time === undefined && dayCfg.enabled === undefined) {
      const oh = getOpeningHoursForDay(today, s);
      res.json({
        enabled: false,
        openingTime: oh.open < 10 ? '0'+Math.floor(oh.open)+':00' : Math.floor(oh.open)+':00',
        settings: s
      });
    } else {
      let enabled = dayCfg.enabled === true;
      if (dayCfg.time) {
        const [th, tm] = dayCfg.time.split(':').map(Number);
        const { h, m } = madridHour();
        const pastTime = h > th || (h === th && m >= tm);
        if (!enabled && pastTime) enabled = true;
        if (enabled && !pastTime) enabled = false;
      }
      res.json({
        enabled,
        openingTime: dayCfg.time || '18:00',
        settings: s
      });
    }
    return;
  }



  // 404 for everything else
  res.status(404).json({ error: 'Not found' });
};


