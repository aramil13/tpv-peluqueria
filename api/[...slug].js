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
    client: { id: client.id, name: client.name, phone: client.phone, email: client.email || '' },
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
  if (url === '/api/debug' && req.method === 'GET') {
    const wa = process.env.TWILIO_WHATSAPP_NUMBER || '';
    const ph = process.env.TWILIO_PHONE_NUMBER || '';
    const sid = process.env.TWILIO_ACCOUNT_SID || '';
    res.json({
      whatsappNumber: wa ? wa.slice(0,6)+'...'+wa.slice(-4) : '(empty)',
      phoneNumber: ph ? ph.slice(0,6)+'...'+ph.slice(-4) : '(empty)',
      accountSid: sid ? sid.slice(0,6)+'...' : '(empty)',
      businessPhone: process.env.BUSINESS_PHONE || ''
    });
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
    const duration = parseInt(durationParam) || (servicesList.length ? servicesList.reduce((sum, s) => sum + (s.duration || 30), 0) : 30);
    const employeesList = (data.employees||[]).filter(e => !e._deleted);
    const appts = (data.appointments||[]).filter(a => a.date === date && !a._deleted);
    const now = new Date();
    const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const isToday = date === todayLocal.toISOString().split('T')[0];
    const currentHour = now.getHours() + now.getMinutes() / 60;
    const BUSINESS_START = 9, BUSINESS_END = 19, SLOT_INTERVAL = 15;
    const slots = [];
    const availableEmps = employeesList.length ? employeesList : [{ id: '', name: 'Sin asignar' }];
    availableEmps.forEach(emp => {
      const empAppts = appts.filter(a => !a.employeeId || a.employeeId === emp.id);
      const allTimes = new Set();
      for (let h = BUSINESS_START; h < BUSINESS_END; h++) {
        for (let m = 0; m < 60; m += SLOT_INTERVAL) allTimes.add(h * 60 + m);
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
          const srv = (data.services||[]).find(s => s.id === a.serviceId);
          const aStart = parseTime(a.time);
          const aEnd = aStart + (srv ? (srv.duration || 30) : 30) / 60;
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
          visits: 0, totalSpent: 0, created: new Date().toISOString(),
          _modified: Date.now(), _deleted: false
        };
        data.clients.push(client);
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
          visits: 0, totalSpent: 0, created: new Date().toISOString(),
          _modified: Date.now(), _deleted: false
        };
        d.clients.push(client);
        await writeData(d);
        res.json({ ok: true, client: { id: client.id, name: client.name, phone: client.phone, email: client.email } });
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
    res.json({ enabled: dayCfg.enabled !== false, openingTime: dayCfg.time || '18:00' });
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

  // 404 for everything else
  res.status(404).json({ error: 'Not found' });
};

function escapeXml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
