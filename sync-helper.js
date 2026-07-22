const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

process.env.TZ = 'Europe/Madrid';
console.log('Starting sync-helper... Forward URL:', process.env.SYNC_FORWARD_URL || '(none)');
const PORT = parseInt(process.env.PORT) || parseInt(process.env.SYNC_PORT) || 3456;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = (() => {
  const d = process.env.SYNC_DATA_DIR || path.join(__dirname, 'sync');
  try { fs.accessSync(d, fs.constants.W_OK); return d; }
  catch (_) { const fallback = path.join(__dirname, 'sync'); console.warn(`Data dir "${d}" not writable, using "${fallback}"`); return fallback; }
})();
const SYNC_FILE = process.env.SYNC_FILE || path.join(DATA_DIR, 'appointments.json');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const SYNC_FORWARD_URL = process.env.SYNC_FORWARD_URL || '';
const SYNC_FORWARD_KEY = process.env.SYNC_FORWARD_KEY || '';
const WEB_API_KEY = process.env.WEB_API_KEY || '';

// Email config
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Nymara Estilistas';
let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
    transporter.verify().then(() => console.log('Email: SMTP OK')).catch(e => console.warn('Email: SMTP verify failed:', e.message));
  } catch (e) { console.warn('Email: nodemailer not available:', e.message); }
} else { console.log('Email: SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)'); }

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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function normPhone(p) {
  const d = (p||'').replace(/[^0-9]/g, '');
  return d.length > 9 ? d.slice(-9) : d;
}

async function handleClientLogin(phone, res) {
  const norm = normPhone(phone);
  console.log('[LOGIN] Phone:', phone, 'Normalized:', norm);
  let d = readData();
  const allClients = (d.clients||[]).filter(c => !c._deleted).map(c => ({ id: c.id, name: c.name, phone: c.phone, norm: normPhone(c.phone) }));
  console.log('[LOGIN] All clients norm phones:', allClients.map(c => c.norm));
  let client = (d.clients||[]).find(c => normPhone(c.phone) === norm && !c._deleted);
  if (!client && SYNC_FORWARD_URL) {
    console.log('[LOGIN] Fetching from sync...');
    await fetchFromSync();
    d = readData();
    client = (d.clients||[]).find(c => normPhone(c.phone) === norm && !c._deleted);
  }
  if (!client) {
    console.log('[LOGIN] Client not found for norm:', norm);
    res.writeHead(404, CORS_HEADERS); res.end(JSON.stringify({ error: 'Cliente no encontrado. ¿El teléfono está registrado?' }));
    return;
  }
  const today = new Date().toISOString().split('T')[0];
  const appointments = (d.appointments||[]).filter(a => a.clientId === client.id && a.date >= today && (!a._deleted || a.cancelledBy === 'client' || a.cancelledBy === 'salon')).sort((a,b) => (a.date+' '+a.time).localeCompare(b.date+' '+b.time));
  const svcMap = {}; (d.services||[]).forEach(s => svcMap[s.id] = s);
  const empMap = {}; (d.employees||[]).forEach(e => empMap[e.id] = e);
  res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    client: { id: client.id, name: client.name, phone: client.phone, email: client.email || '' },
    appointments: appointments.map(a => ({
      id: a.id, date: a.date, time: a.time, endTime: a.endTime || '',
      status: a.status, source: a.source || '',
      employeeId: a.employeeId || '',
      employeeName: a.employeeId && empMap[a.employeeId] ? empMap[a.employeeId].name : '',
      serviceName: svcMap[a.serviceId] ? svcMap[a.serviceId].name : '',
      serviceId: a.serviceId, notes: a.notes || '',
      _deleted: !!a._deleted,
      cancelledBy: a.cancelledBy || '',
      salonModified: !!a.salonModified,
      modificationCount: a.modificationCount || 0,
      clientModified: !!a.clientModified, pendingTime: a.pendingTime || '', pendingDate: a.pendingDate || '',
      pendingEmployeeId: a.pendingEmployeeId || '',
      pendingEmployeeName: a.pendingEmployeeId && empMap[a.pendingEmployeeId] ? empMap[a.pendingEmployeeId].name : '',
      pendingSalonConfirm: !!a.pendingSalonConfirm
    }))
  }));
}

function fetchFromSync() {
  return new Promise(resolve => {
    if (!SYNC_FORWARD_URL) { resolve(false); return; }
    const url = SYNC_FORWARD_URL.replace(/\/+$/, '') + '/sync';
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(false); return; }
        try {
          const remote = JSON.parse(data);
          const current = readData();
          const LIST_KEYS = ['appointments','clients','services','sections','employees','products','providers'];
          LIST_KEYS.forEach(k => {
            if (Array.isArray(remote[k])) current[k] = mergeArray(Array.isArray(current[k])?current[k]:[], remote[k]);
          });
          current.clients = dedupClients(current.clients);
          writeData(current);
          resolve(true);
        } catch(e) { resolve(false); }
      });
    }).on('error', () => resolve(false));
  });
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readData() {
  try {
    if (fs.existsSync(SYNC_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
      if (!Array.isArray(raw.clients)) raw.clients = [];
      if (!Array.isArray(raw.services)) raw.services = [];
      if (!Array.isArray(raw.employees)) raw.employees = [];
      if (!Array.isArray(raw.appointments)) raw.appointments = [];
      if (!Array.isArray(raw.products)) raw.products = [];
      if (!Array.isArray(raw.projects)) raw.projects = [];
      if (!Array.isArray(raw.movements)) raw.movements = [];
      if (!Array.isArray(raw.sections)) raw.sections = [];
      if (!Array.isArray(raw.providers)) raw.providers = [];
      if (!raw.settings) raw.settings = {};
      
      // Auto-heal database on read (remove binary Excel corrupted items)
      ['clients', 'employees', 'services', 'sections', 'projects', 'products', 'providers'].forEach(k => {
        if (Array.isArray(raw[k])) {
          raw[k] = raw[k].filter(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
            if (typeof item.name !== 'string' || item.name.trim() === '') return false;
            const keys = Object.keys(item);
            const isCorrupted = keys.some(key => key.includes('\u0011') || key.includes('\u001a') || key.includes('\u0000') || key.includes('\u0003') || key.includes('\u0004'));
            return !isCorrupted;
          });
        }
      });

      return raw;
    }
  } catch (e) { /* fall through */ }
  return { appointments: [], clients: [], services: [], employees: [], products: [], projects: [], movements: [], sections: [], providers: [], settings: {}, lastModified: 0 };
}

function writeData(data) {
  try {
    ensureDir(SYNC_FILE);
    const today = new Date().toISOString().split('T')[0];
    (data.appointments||[]).forEach(a => { if (a.date < today) { a._deleted = true; a._modified = Date.now(); } });
    data.lastModified = Date.now();
    fs.writeFileSync(SYNC_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error writing data:', e);
    throw e; // Re-throw to be caught by the POST handler
  }
}

function normPhone(p) {
  const d = (p || '').replace(/[^0-9]/g, '');
  return d.length > 9 ? d.slice(-9) : d;
}

function dedupClients(clients) {
  const seen = new Map();
  return (clients || []).filter(c => {
    if (!c || !c.phone) return true;
    const np = normPhone(c.phone);
    if (!np) return true;
    if (seen.has(np)) return false;
    seen.set(np, c);
    return true;
  });
}

function mergeArray(local, remote) {
  const map = new Map();
  const phoneMap = new Map();
  if (Array.isArray(local)) local.forEach(item => {
    map.set(item.id, item);
    if (item.phone) phoneMap.set(normPhone(item.phone), item.id);
  });
  if (Array.isArray(remote)) remote.forEach(item => {
    if (map.has(item.id)) {
      const existing = map.get(item.id);
      // Only apply remote changes if remote is newer
      if ((item._modified || 0) > (existing._modified || 0)) {
        if (item.cancelledBy) {
          if (item.cancelledBy !== 'client') delete item._deleted;
          if (existing._deleted && !existing.cancelledBy) return;
          map.set(item.id, item); return;
        }
        if (item._deleted) {
          if ((existing.cancelledBy) && !item.cancelledBy) return;
          map.set(item.id, item); return;
        }
        map.set(item.id, item);
      }
    } else {
      if (item.phone) {
        const np = normPhone(item.phone);
        if (phoneMap.has(np)) {
          const existingId = phoneMap.get(np);
          const existing = map.get(existingId);
          if (existing && (item._modified || 0) > (existing._modified || 0)) {
            map.delete(existingId);
            map.set(item.id, item);
            phoneMap.set(np, item.id);
          }
          return;
        }
        phoneMap.set(np, item.id);
      }
      map.set(item.id, item);
    }
  });
  return Array.from(map.values());
}

function pathname(url) { return url.split('?')[0].split('#')[0] }

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

function requireWebAuth(req, res) {
  if (!WEB_API_KEY) return true;
  const auth = req.headers['authorization'] || '';
  return auth === 'Bearer ' + WEB_API_KEY || auth === WEB_API_KEY;
}

// === SEED DATA for fresh deployments (Render) ===
function seedInitialData() {
  if (fs.existsSync(SYNC_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
      // Only seed if file is truly empty: no services, products, projects, appointments, clients
      const hasData = ['services','products','projects','appointments','clients','employees'].some(k => Array.isArray(existing[k]) && existing[k].length > 0);
      if (hasData) return;
    } catch (_) { /* recreate */ }
  }
  ensureDir(SYNC_FILE);
  const sections = [
    { id:'sec1', name:'Corte', color:'#8E44AD', _deleted:false, _modified:Date.now() },
    { id:'sec2', name:'Color', color:'#E74C3C', _deleted:false, _modified:Date.now() },
    { id:'sec3', name:'Tratamiento', color:'#27AE60', _deleted:false, _modified:Date.now() },
    { id:'sec4', name:'Peinado', color:'#F39C12', _deleted:false, _modified:Date.now() },
    { id:'sec5', name:'Manicura', color:'#3498DB', _deleted:false, _modified:Date.now() }
  ];
  const services = [
    { id:'srv1', name:'Corte de cabello', price:15, duration:30, sectionId:'sec1', _deleted:false, _modified:Date.now() },
    { id:'srv2', name:'Corte infantíl', price:10, duration:20, sectionId:'sec1', _deleted:false, _modified:Date.now() },
    { id:'srv3', name:'Tinte completo', price:45, duration:90, sectionId:'sec2', _deleted:false, _modified:Date.now() },
    { id:'srv4', name:'Mechas', price:55, duration:120, sectionId:'sec2', _deleted:false, _modified:Date.now() },
    { id:'srv5', name:'Lavado y secado', price:8, duration:20, sectionId:'sec3', _deleted:false, _modified:Date.now() },
    { id:'srv6', name:'Tratamiento keratina', price:35, duration:60, sectionId:'sec3', _deleted:false, _modified:Date.now() },
    { id:'srv7', name:'Peinado de fiesta', price:25, duration:45, sectionId:'sec4', _deleted:false, _modified:Date.now() },
    { id:'srv8', name:'Recogido', price:30, duration:40, sectionId:'sec4', _deleted:false, _modified:Date.now() },
    { id:'srv9', name:'Manicura básica', price:18, duration:30, sectionId:'sec5', _deleted:false, _modified:Date.now() },
    { id:'srv10', name:'Uñas de gel', price:35, duration:60, sectionId:'sec5', _deleted:false, _modified:Date.now() }
  ];
  const employees = [
    { id:'emp1', name:'Laura García', color:'#8E44AD', phone:'', email:'', commission:50, _deleted:false, _modified:Date.now() },
    { id:'emp2', name:'Carlos Martínez', color:'#3498DB', phone:'', email:'', commission:50, _deleted:false, _modified:Date.now() },
    { id:'emp3', name:'Ana López', color:'#E74C3C', phone:'', email:'', commission:50, _deleted:false, _modified:Date.now() }
  ];
  const data = {
    sections, services, employees,
    clients: [], products: [], projects: [], movements: [], appointments: [],
    providers: [], settings: { businessName:'Peluquería Ejemplo', businessPhone:'612345678' },
    lastModified: Date.now()
  };
  writeData(data);
  console.log('Seed data created with ' + services.length + ' services, ' + employees.length + ' employees');
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = pathname(req.url);

  if (url === '/sync' || url === '/sync/') {
    if (req.method === 'GET') {
      const data = readData();
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const remote = JSON.parse(body);
          const current = readData();
          const merged = { ...current };
          const wasCancelledOrDeleted = new Set();
          (current.appointments||[]).forEach(a => { if (a && (a.cancelledBy || a._deleted)) wasCancelledOrDeleted.add(a.id); });
          const LIST_KEYS = ['appointments', 'clients', 'services', 'employees', 'products', 'projects', 'movements', 'sections', 'providers'];
          LIST_KEYS.forEach(k => {
            if (Array.isArray(remote[k])) {
              merged[k] = mergeArray(Array.isArray(current[k]) ? current[k] : [], remote[k]);
            }
          });
    merged.settings = remote.settings || current.settings || {};
    merged.clients = dedupClients(merged.clients);
    (merged.appointments||[]).forEach(a => {
      if (a && !a.cancelledBy && !a._deleted && wasCancelledOrDeleted.has(a.id)) {
        const orig = (current.appointments||[]).find(x => x && x.id === a.id);
        if (orig) {
          if (orig.cancelledBy) a.cancelledBy = orig.cancelledBy;
          if (orig._deleted) a._deleted = true;
          if (orig.cancelledBy || orig._deleted) a._modified = Date.now();
        }
      }
    });
    writeData(merged);
    console.log('POST /sync: stored', 
      (remote.products||[]).length, 'products,',
      (remote.projects||[]).length, 'projects,',
      (remote.services||[]).length, 'services,',
      (remote.appointments||[]).length, 'appointments,',
      (remote.clients||[]).length, 'clients');
    // Forward all received data to SYNC_FORWARD_URL if configured
    if (SYNC_FORWARD_URL) {
      const fwdUrl = SYNC_FORWARD_URL.replace(/\/+$/, '') + '/sync';
      const fwdHeaders = { 'Content-Type': 'application/json' };
      if (SYNC_FORWARD_KEY) fwdHeaders['Authorization'] = 'Bearer ' + SYNC_FORWARD_KEY;
      const fwdMod = fwdUrl.startsWith('https') ? https : http;
      const fwdReq = fwdMod.request(fwdUrl, { method: 'POST', headers: fwdHeaders }, (fwdRes) => {
        let fwdData = '';
        fwdRes.on('data', c => fwdData += c);
        fwdRes.on('end', () => {
          if (fwdRes.statusCode === 200) console.log('Forward /sync: OK');
          else console.warn('Forward /sync: HTTP ' + fwdRes.statusCode + ' - ' + fwdData);
        });
      });
      fwdReq.on('error', e => console.error('Forward /sync error:', e.message));
      fwdReq.write(body);
      fwdReq.end();
    }
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      appointments: (Array.isArray(merged.appointments) ? merged.appointments : []).length,
      clients: (Array.isArray(merged.clients) ? merged.clients : []).length,
      services: (Array.isArray(merged.services) ? merged.services : []).length,
      employees: (Array.isArray(merged.employees) ? merged.employees : []).length,
      lastModified: merged.lastModified
    }));
        } catch (e) {
          console.error('POST /sync error:', e);
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  if (url === '/health') {
    const data = readData();
    const totalProducts = (data.products||[]).length;
    const webProducts = (data.products||[]).filter(p => p.showOnWeb).length;
    const totalProjects = (data.projects||[]).length;
    const webProjects = (data.projects||[]).filter(p => p.showOnWeb).length;
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', file: SYNC_FILE,
      appointments: (data.appointments || []).length,
      clients: (data.clients || []).length,
      services: (data.services || []).length,
      employees: (data.employees || []).length,
      products: totalProducts,
      webProducts: webProducts,
      projects: totalProjects,
      webProjects: webProjects,
      forwardUrl: SYNC_FORWARD_URL || '(none)',
      lastModified: data.lastModified
    }));
    return;
  }

  if (url === '/debug') {
    const data = readData();
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html' });
    const appts = (data.appointments || []).filter(a => !a._deleted);
    res.end(`<pre>
SYNC_FORWARD_URL: ${SYNC_FORWARD_URL || '(not set)'}
SYNC_FORWARD_KEY: ${SYNC_FORWARD_KEY ? '(set)' : '(not set)'}
DATA_DIR: ${DATA_DIR}
SYNC_FILE: ${SYNC_FILE}
Appointments: ${appts.length}
Clients: ${(data.clients||[]).length}
${appts.map(a => JSON.stringify(a, null, 2)).join('\n---\n')}
</pre>`);
    return;
  }

  // === BOOKING API ===
  if (url === '/api/slots') {
    const data = readData();
    const q = new URLSearchParams(req.url.split('?')[1]||'');
    const date = q.get('date');
    const serviceId = q.get('serviceId');
    if (!date || !serviceId) {
      res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'date and serviceId required' }));
      return;
    }
    const service = (data.services||[]).find(s => s.id === serviceId && !s._deleted);
    if (!service) {
      res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Service not found' }));
      return;
    }
    const duration = service.duration || 30;
    const employeesList = (data.employees||[]).filter(e => !e._deleted);
    const appts = (data.appointments||[]).filter(a => a.date === date && !a._deleted && !a.cancelledBy);
    const now = new Date();
    const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const isToday = date === todayLocal.toISOString().split('T')[0];
    const currentHour = now.getHours() + now.getMinutes() / 60;

    const dayHours = getOpeningHoursForDay(date, data.settings);
    if (dayHours.closed) {
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slots: [], date, serviceId, duration, closed: true }));
      return;
    }
    const BUSINESS_START = dayHours.open;
    const BUSINESS_END = dayHours.close;
    const SLOT_INTERVAL = 15;
    const BREAK_START = dayHours.breakStart, BREAK_END = dayHours.breakEnd;
    const isInBreak = (t) => BREAK_START !== null && BREAK_END !== null && t >= BREAK_START && t < BREAK_END;

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
        if (mins >= BUSINESS_START * 60 && mins < BUSINESS_END * 60) {
          allTimes.add(mins);
        }
      });
      
      const sortedMins = [...allTimes].sort((a, b) => a - b);
      
      sortedMins.forEach(totalMins => {
        const h = Math.floor(totalMins / 60);
        const m = totalMins % 60;
        const start = h + m / 60;
        const end = start + duration / 60;
        if (end > BUSINESS_END) return;
        if (isToday && start < currentHour) return;
        if (isInBreak(start)) return;
        if (BREAK_START !== null && BREAK_END !== null && start < BREAK_END && end > BREAK_START) return;
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
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ slots, date, serviceId, duration }));
    return;
  }

  if (url === '/api/book' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const b = JSON.parse(body);
            const data = readData();
        if (!b.serviceId || !b.date || !b.time || !b.clientName || !b.clientPhone) {
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Faltan campos obligatorios' }));
          return;
        }
        // Find or create client
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
        // Check availability
        const empId = b.employeeId || '';
        const empAppts = (data.appointments||[]).filter(a => a.date === b.date && !a._deleted && !a.cancelledBy && (!empId || a.employeeId === empId || !a.employeeId));
        const srv = (data.services||[]).find(s => s.id === b.serviceId);
        const srvDuration = srv ? srv.duration : 30;
        const reqStart = parseTime(b.time);
        const reqEnd = reqStart + srvDuration / 60;
        const bkHours = getOpeningHoursForDay(b.date, data.settings);
        if (bkHours.breakStart !== null && bkHours.breakEnd !== null && reqStart < bkHours.breakEnd && reqEnd > bkHours.breakStart) {
          res.writeHead(409, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Esa hora cae en el horario de descanso del mediodía. Por favor, elige otra hora.' }));
          return;
        }
        const conflict = empAppts.find(a => {
          const as = (data.services||[]).find(s => s.id === a.serviceId);
          const aStart = parseTime(a.time);
          const aEnd = aStart + (as ? (as.duration || 30) : 30) / 60;
          return reqStart < aEnd && reqEnd > aStart;
        });
        if (conflict) {
          const cli = (data.clients||[]).find(c => c.id === conflict.clientId);
          res.writeHead(409, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Este horario ya no está disponible. '+cli?.name+' tiene cita de '+conflict.time+' a '+(conflict.endTime||'') }));
          return;
        }
        // Calculate endTime
        const reqEndH = Math.floor(reqEnd);
        const reqEndM = Math.round((reqEnd - reqEndH) * 60);
        const endTime = String(reqEndH).padStart(2,'0')+':'+String(reqEndM).padStart(2,'0');
        // Create appointment
        const appt = {
          id: 'a'+Date.now().toString(36)+Math.random().toString(36).substr(2,4),
          clientId: client.id, serviceId: b.serviceId,
          employeeId: empId, date: b.date, time: b.time, endTime: endTime,
          notes: b.notes || 'Reserva online',
          source: 'online', status: 'pending', pendingSalonConfirm: true, _modified: Date.now(), _deleted: false, modificationCount: 0, salonModified: false, cancelledBy: ''
        };
        data.appointments.push(appt);
        writeData(data);
        forwardAppointment(appt, client);
        const service = (data.services||[]).find(s => s.id === b.serviceId);
        const emp = (data.employees||[]).find(e => e.id === b.employeeId);
        sendConfirmationEmail(b.clientEmail, b.clientName, b.date, b.time, service ? service.name : 'Servicio', emp ? emp.name : '', b.notes);
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, appointmentId: appt.id, emailSent: !!(transporter && b.clientEmail) }));
      } catch(e) {
        res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === DEBUG ===
  if (url === '/api/debug' && req.method === 'GET') {
    const d = readData();
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      syncUrl: SYNC_FORWARD_URL || '(none)',
      clients: (d.clients||[]).filter(c => !c._deleted).length,
      totalClients: (d.clients||[]).length,
      services: (d.services||[]).filter(s => !s._deleted).length,
      employees: (d.employees||[]).filter(e => !e._deleted).length,
      appointments: (d.appointments||[]).filter(a => !a._deleted).length
    }));
    return;
  }

  if (url === '/api/web-products' && req.method === 'GET') {
    if (!requireWebAuth(req, res)) {
      res.writeHead(401, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const d = readData();
    const allProducts = d.products||[];
    const webProducts = allProducts.filter(p => (p.showOnWeb || p.showWeb));
    console.log('/api/web-products:', webProducts.length, 'of', allProducts.length, 'total products (incl. archived)');
    const body = JSON.stringify(webProducts.map(p => ({
      id: p.id,
      name: p.name || '',
      price: p.price,
      description: p.description||'',
      photo: sanitizeUrl(p.photo)
    })));
    const etag = computeETag(body);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ...CORS_HEADERS, 'ETag': etag });
      res.end();
      return;
    }
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'ETag': etag, 'Cache-Control': 'no-cache' });
    res.end(body);
    return;
  }

  if (url === '/api/web-offers' && req.method === 'GET') {
    if (!requireWebAuth(req, res)) {
      res.writeHead(401, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const d = readData();
    const allProjects = d.projects||[];
    const webOffers = allProjects.filter(p => (p.showOnWeb || p.showWeb));
    console.log('/api/web-offers:', webOffers.length, 'of', allProjects.length, 'total projects (incl. archived)');
    const svcMap = {}; (d.services||[]).forEach(s => svcMap[s.id] = s);
    const prodMap = {}; (d.products||[]).forEach(p => prodMap[p.id] = p);
    const payload = webOffers.map(p => {
      const serviceTotal = (p.services||[]).reduce((sum, sid) => { const price = svcMap[sid]?.price || 0; return sum + price; }, 0);
      const productTotal = (p.products||[]).reduce((sum, pid) => { const price = prodMap[pid]?.price || 0; return sum + price; }, 0);
      const subtotal = serviceTotal + productTotal;
      const discount = p.discount || 0;
      const totalPrice = subtotal * (1 - discount / 100);
      return { 
        id: p.id,
        name: p.name||'', 
        services: (p.services||[]).map(sid => svcMap[sid] ? svcMap[sid].name : null).filter(Boolean), 
        products: (p.products||[]).map(pid => prodMap[pid] ? prodMap[pid].name : null).filter(Boolean), 
        discount: p.discount||0, 
        description: p.description||'', 
        photo: sanitizeUrl(p.photo), 
        totalPrice: Math.round(totalPrice * 100) / 100 
      };
    });
    const body = JSON.stringify(payload);
    const etag = computeETag(body);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ...CORS_HEADERS, 'ETag': etag });
      res.end();
      return;
    }
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'ETag': etag, 'Cache-Control': 'no-cache' });
    res.end(body);
    return;
  }

  if (url === '/api/sync-pull' && req.method === 'POST') {
    pullFromSync();
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Sync pull triggered' }));
    return;
  }

  if (url === '/api/online-status' && req.method === 'GET') {
    const d = readData();
    const s = d.settings || {};
    const today = new Date().toISOString().split('T')[0];
    const dayCfg = (s.onlineOpening || {})[today] || {};
    if (dayCfg.time === undefined && dayCfg.enabled === undefined) {
      const oh = getOpeningHoursForDay(today, s);
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        enabled: !oh.closed,
        openingTime: oh.open < 10 ? '0'+Math.floor(oh.open)+':00' : Math.floor(oh.open)+':00',
        settings: s
      }));
    } else {
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        enabled: dayCfg.enabled !== false,
        openingTime: dayCfg.time || '18:00',
        settings: s
      }));
    }
    return;
  }

  // === CLIENT API ===
  if (url === '/api/client' && req.method === 'GET') {
    const phone = (new URL(req.url, 'http://x')).searchParams.get('phone');
    if (!phone) {
      res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: 'phone required' }));
      return;
    }
    handleClientLogin(phone, res);
    return;
  }

  if (url === '/api/client' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const b = JSON.parse(body);
        if (!b.name || !b.phone) {
          res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: 'name and phone required' }));
          return;
        }
        const d = readData();
        if ((d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted)) {
          res.writeHead(409, CORS_HEADERS); res.end(JSON.stringify({ error: 'Ya existe un cliente con ese teléfono' }));
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
        writeData(d);
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, client: { id: client.id, name: client.name, phone: client.phone, email: client.email } }));
      } catch(e) {
        res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url === '/api/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const b = JSON.parse(body);
        if (!b.appointmentId || !b.phone) {
          res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: 'appointmentId and phone required' }));
          return;
        }
        const d = readData();
        const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
        if (!client) {
          res.writeHead(403, CORS_HEADERS); res.end(JSON.stringify({ error: 'Cliente no encontrado' }));
          return;
        }
        const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && (!a._deleted || a.cancelledBy === 'salon'));
        if (!appt) {
          res.writeHead(404, CORS_HEADERS); res.end(JSON.stringify({ error: 'Cita no encontrada' }));
          return;
        }
        if (appt.source !== 'online') {
          res.writeHead(403, CORS_HEADERS); res.end(JSON.stringify({ error: 'Solo puedes cancelar citas creadas online' }));
          return;
        }
        if (appt.date < new Date().toISOString().split('T')[0]) {
          res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: 'No puedes cancelar una cita pasada' }));
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
        writeData(d);
        forwardAppointment(appt, client);
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url === '/api/accept-modification' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const b = JSON.parse(body);
        if (!b.appointmentId || !b.phone) {
          res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: 'appointmentId and phone required' }));
          return;
        }
        const d = readData();
        const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
        if (!client) {
          res.writeHead(403, CORS_HEADERS); res.end(JSON.stringify({ error: 'Cliente no encontrado' }));
          return;
        }
        const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && !a._deleted);
        if (!appt) {
          res.writeHead(404, CORS_HEADERS); res.end(JSON.stringify({ error: 'Cita no encontrada' }));
          return;
        }
        if (appt.source !== 'online') {
          res.writeHead(403, CORS_HEADERS); res.end(JSON.stringify({ error: 'Solo puedes aceptar modificaciones de citas online' }));
          return;
        }
        if (!appt.salonModified) {
          res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: 'La cita no tiene modificaciones pendientes' }));
          return;
        }
        appt.salonModified = false;
        appt._modified = Date.now();
        writeData(d);
        forwardAppointment(appt, client);
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url === '/api/modify' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const b = JSON.parse(body);
        if (!b.appointmentId || !b.phone || !b.newTime) {
          res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: 'appointmentId, phone, newTime required' }));
          return;
        }
        const d = readData();
        const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
        if (!client) {
          res.writeHead(403, CORS_HEADERS); res.end(JSON.stringify({ error: 'Cliente no encontrado' }));
          return;
        }
        const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && !a._deleted);
        if (!appt) {
          res.writeHead(404, CORS_HEADERS); res.end(JSON.stringify({ error: 'Cita no encontrada' }));
          return;
        }
        if (appt.source !== 'online') {
          res.writeHead(403, CORS_HEADERS); res.end(JSON.stringify({ error: 'Solo puedes modificar citas creadas online' }));
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
          res.writeHead(409, CORS_HEADERS); res.end(JSON.stringify({ error: 'El nuevo horario no está disponible' }));
          return;
        }
        if ((appt.modificationCount || 0) >= 1) {
          res.writeHead(403, CORS_HEADERS); res.end(JSON.stringify({ error: 'Ya has modificado esta cita anteriormente. Solo puedes modificarla una vez.' }));
          return;
        }
        appt.modificationCount = (appt.modificationCount || 0) + 1;
        appt.clientModified = true;
        appt.pendingDate = newDate;
        appt.pendingTime = b.newTime;
        appt.pendingEmployeeId = newEmpId;
        appt._modified = Date.now();
        writeData(d);
        forwardAppointment(appt, client);
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, appointment: { id: appt.id, pendingDate: appt.pendingDate, pendingTime: appt.pendingTime } }));
      } catch(e) {
        res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url === '/api/accept-client-modification' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const b = JSON.parse(body);
        if (!b.appointmentId || !b.phone) {
          res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: 'appointmentId and phone required' }));
          return;
        }
        const d = readData();
        const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
        if (!client) {
          res.writeHead(403, CORS_HEADERS); res.end(JSON.stringify({ error: 'Cliente no encontrado' }));
          return;
        }
        const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && !a._deleted);
        if (!appt) {
          res.writeHead(404, CORS_HEADERS); res.end(JSON.stringify({ error: 'Cita no encontrada' }));
          return;
        }
        if (!appt.clientModified) {
          res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: 'La cita no tiene modificaciones pendientes del cliente' }));
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
        } else {
        }
        appt.clientModified = false;
        delete appt.pendingDate;
        delete appt.pendingTime;
        delete appt.pendingEmployeeId;
        appt._modified = Date.now();
        writeData(d);
        forwardAppointment(appt, client);
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, appointment: { id: appt.id, date: appt.date, time: appt.time } }));
      } catch(e) {
        res.writeHead(400, CORS_HEADERS); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: AI MESSAGE (WhatsApp Bridge) ===
  if (url === '/api/ai-message' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { phone, text } = JSON.parse(body);
        let replyText = '';
        if (phone && text) {
          const { processWhatsAppMessage } = require('./lib/ai-assistant');
          replyText = await processWhatsAppMessage(phone, text) || '';
        }
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: replyText }));
      } catch (e) {
        console.error('[AI MESSAGE ERROR]', e.message);
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'Lo siento, hubo un error.' }));
      }
    });
    return;
  }

  // === WEBSITE STATIC FILES ===
  const WEBSITE_DIR = path.join(__dirname, 'website');
  const WEB_PATHS = ['/', ''];
  if (WEB_PATHS.includes(url)) {
    sendStaticFile(res, WEBSITE_DIR, '/index.html');
    return;
  }
  if (url.startsWith('/style.css') && !url.startsWith('/booking')) {
    sendStaticFile(res, WEBSITE_DIR, url);
    return;
  }
  // Website assets (images, etc.)
  if (url.startsWith('/') && !url.startsWith('/booking') && !url.startsWith('/api/') && url !== '/health' && url !== '/debug') {
    const ext = path.extname(url).toLowerCase();
    if (['.webp','.png','.jpg','.jpeg','.svg','.ico','.gif','.txt','.xml'].includes(ext)) {
      sendStaticFile(res, WEBSITE_DIR, url);
      return;
    }
  }

  // === BOOKING STATIC FILES ===
  const BOOKING_DIR = path.join(__dirname, 'booking');
  const BOOKING_PATHS = ['/booking', '/booking/'];
  if (BOOKING_PATHS.includes(url) || (url.startsWith('/booking/') && url.length > 9)) {
    let filePath;
    if (url.startsWith('/booking/') && url.length > 9) {
      filePath = url.replace('/booking', '');
    } else {
      filePath = '/index.html';
    }
    sendStaticFile(res, BOOKING_DIR, filePath);
    return;
  }

  // === BOOKING ASSETS (css, js) ===
  if (url.startsWith('/booking/style.css') || url.startsWith('/booking/booking.js')) {
    sendStaticFile(res, BOOKING_DIR, url.replace('/booking', ''));
    return;
  }

  res.writeHead(404, CORS_HEADERS); res.end('Not found');
  return;
});

function sendStaticFile(res, baseDir, filePath) {
  const fullPath = path.join(baseDir, decodeURIComponent(filePath));
  if (!fullPath.startsWith(baseDir)) {
    res.writeHead(403, CORS_HEADERS); res.end('Forbidden');
    return;
  }
  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, CORS_HEADERS); res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath);
    const mimes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif' };
    let data = content;
    if (ext === '.html' && WEB_API_KEY) {
      const inject = `<script>window.__WEB_API_KEY__=${JSON.stringify(WEB_API_KEY)};</script>`;
      data = content.toString().replace('</head>', inject + '</head>');
    }
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': mimes[ext] || 'application/octet-stream' });
    res.end(data);
  });
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

function pullFromSync() {
  let url = SYNC_FORWARD_URL ? SYNC_FORWARD_URL.replace(/\/+$/, '') + '/sync' : null;
  if (!url) {
    const proto = process.env.RENDER ? 'https' : 'http';
    const host = process.env.RENDER_EXTERNAL_URL || 'localhost:' + PORT;
    url = proto + '://' + host + '/sync';
  }
  const mod = url.startsWith('https') ? https : http;
  mod.get(url, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode !== 200) return;
      try {
        const remote = JSON.parse(data);
        const current = readData();
        const LIST_KEYS = ['appointments', 'clients', 'services', 'sections', 'employees', 'products', 'projects', 'providers'];
        let changed = false;
        LIST_KEYS.forEach(k => {
          if (Array.isArray(remote[k])) {
            const before = (current[k]||[]).length;
            current[k] = mergeArray(Array.isArray(current[k]) ? current[k] : [], remote[k]);
            if (current[k].length !== before) changed = true;
          }
        });
        current.clients = dedupClients(current.clients);
        if (Array.isArray(remote.appointments)) {
          const remoteMap = {};
          remote.appointments.forEach(a => { if (a.id) remoteMap[a.id] = a; });
          (current.appointments||[]).forEach(a => {
            const r = remoteMap[a.id];
            if (r && r._deleted) { a._deleted = true; changed = true; }
          });
        }
        if (remote.settings && typeof remote.settings === 'object') {
          const curSettings = current.settings || {};
          const merged = { ...curSettings, ...remote.settings };
          if (JSON.stringify(curSettings) !== JSON.stringify(merged)) {
            current.settings = merged;
            changed = true;
          }
        }
        if (changed) { writeData(current); console.log('Sync pull: data updated from', url); }
        else console.log('Sync pull: no changes from', url);
      } catch (e) { console.warn('Sync pull parse error:', e.message); }
    });
  }).on('error', e => console.warn('Sync pull error:', e.message));
}

function forwardAppointment(appt, client) {
  if (!SYNC_FORWARD_URL) { console.log('Forward: no SYNC_FORWARD_URL set'); return; }
  const url = SYNC_FORWARD_URL.replace(/\/+$/, '') + '/sync';
  const headers = { 'Content-Type': 'application/json' };
  if (SYNC_FORWARD_KEY) headers['Authorization'] = 'Bearer ' + SYNC_FORWARD_KEY;
  const body = JSON.stringify({
    appointments: [appt],
    clients: [client]
  });
  const mod = url.startsWith('https') ? https : http;
  console.log('Forward: sending to ' + url + ' (appt=' + appt.id + ')');
  const req = mod.request(url, { method: 'POST', headers }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode === 200) console.log('Forward: success for ' + appt.id);
      else console.warn('Forward: returned HTTP ' + res.statusCode + ' for ' + appt.id + ' - ' + data);
    });
  });
  req.on('error', e => console.error('Forward: error for ' + appt.id + ' - ' + e.message));
  req.write(body);
  req.end();
}

seedInitialData();

if (SYNC_FORWARD_URL) {
  pullFromSync();
  setInterval(pullFromSync, 30000);
  console.log('Sync pull: polling', SYNC_FORWARD_URL, 'every 30s');
} else {
  console.log('Sync pull: disabled (no SYNC_FORWARD_URL set)');
}

server.listen(PORT, HOST, () => {
  const addr = typeof HOST === 'string' && HOST === '0.0.0.0'
    ? '0.0.0.0 (all interfaces)'
    : HOST;
  console.log(`Sync Helper running on http://${addr}:${PORT}`);
  console.log(`Sync file: ${SYNC_FILE}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Booking: http://localhost:${PORT}/`);
  console.log(`Booking (alt): http://localhost:${PORT}/booking`);
  console.log(`CORS origin: ${CORS_ORIGIN}`);
  console.log(`Self-sync: ${SYNC_FORWARD_URL ? 'enabled (pulling every 30s from ' + SYNC_FORWARD_URL + ')' : 'disabled (no SYNC_FORWARD_URL)'}`);
});
