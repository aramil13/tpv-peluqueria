const { readData, writeData, mergeArray, dedupClients } = require('../../lib/kv-data');

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (!env.R2_DATA) {
      return new Response(JSON.stringify({ error: 'R2_DATA binding no configurado. Ve a Cloudflare Pages > Settings > Functions > R2 Bucket Bindings' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    globalThis.__ENV = env;

    const CORS_ORIGIN = env.CORS_ORIGIN || '*';
    const WEB_API_KEY = env.WEB_API_KEY || '';
    const BUSINESS_NAME = env.BUSINESS_NAME || 'Nymara Estilistas';
    const BUSINESS_PHONE = env.BUSINESS_PHONE || '';

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



  async function computeETag(data) {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(data)));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return '"' + hashHex.slice(0, 16) + '"';
  }

  function sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const s = url.trim();
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:image/')) return s;
    return '';
  }

  function requireWebAuth(req) {
    if (!WEB_API_KEY) return true;
    const auth = req.headers.get('authorization') || '';
    return auth === 'Bearer ' + WEB_API_KEY || auth === WEB_API_KEY;
  }

  function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
    });
  }







  function noContent() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }



  if (request.method === 'OPTIONS') {
    return noContent();
  }

  const url = new URL(request.url);
  const path = url.pathname;

  async function getBody() {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/x-www-form-urlencoded') || ct.includes('text/xml')) {
      const raw = await request.text();
      return raw;
    }
    if (ct.includes('application/json')) {
      return request.json();
    }
    const raw = await request.text();
    try { return JSON.parse(raw); } catch { return raw; }
  }

  async function handleClientLogin(phone) {
    const norm = normPhone(phone);
    const d = await readData();
    const client = (d.clients||[]).find(c => normPhone(c.phone) === norm && !c._deleted);
    if (!client) {
      return json({ error: 'Cliente no encontrado. ¿El teléfono está registrado?' }, 404);
    }
    const today = new Date().toISOString().split('T')[0];
    const appointments = (d.appointments||[]).filter(a => a.clientId === client.id && a.date >= today && !a._deleted).sort((a,b) => (a.date+' '+a.time).localeCompare(b.date+' '+b.time));
    const svcMap = {}; (d.services||[]).forEach(s => svcMap[s.id] = s);
    const empMap = {}; (d.employees||[]).forEach(e => empMap[e.id] = e);
    appointments.sort((a,b) => (a.date+' '+a.time).localeCompare(b.date+' '+b.time));
    const processed = new Set();
    const result = [];
    for (const a of appointments) {
      if (processed.has(a.id)) continue;
      if (a.blockGroupId) {
        const groupAppts = appointments.filter(x => x.blockGroupId === a.blockGroupId);
        groupAppts.forEach(ga => processed.add(ga.id));
        const b1 = groupAppts.find(x => x.blockNum === '1') || groupAppts[0];
        const b2 = groupAppts.find(x => x.blockNum === '2');
        const allSvcIds = [];
        const allSvcNames = [];
        const allEmpIds = new Set();
        for (const ga of groupAppts) {
          const sids = ga.serviceIds || (ga.serviceId ? [ga.serviceId] : []);
          sids.forEach(id => {
            if (!allSvcIds.includes(id)) allSvcIds.push(id);
            if (svcMap[id] && !allSvcNames.includes(svcMap[id].name)) allSvcNames.push(svcMap[id].name);
          });
          if (ga.employeeId) allEmpIds.add(ga.employeeId);
        }
        const primaryEmp = b1.employeeId || '';
        const pendingB1Time = b1.pendingTime || '';
        const pendingB1Date = b1.pendingDate || '';
        result.push({
          id: b1.id, blockGroupId: a.blockGroupId, blockCount: groupAppts.length,
          date: b1.date, time: b1.time, endTime: b2 ? b2.endTime : (b1.endTime || ''),
          serviceIds: allSvcIds, serviceId: b1.serviceId || allSvcIds[0] || '',
          serviceName: allSvcNames.join(' + '),
          status: b1.status, source: b1.source || '',
          employeeId: primaryEmp,
          employeeName: primaryEmp && empMap[primaryEmp] ? empMap[primaryEmp].name : '',
          notes: b1.notes || '',
          _deleted: !!b1._deleted, cancelledBy: b1.cancelledBy || '',
          salonModified: groupAppts.some(ga => ga.salonModified),
          modificationCount: b1.modificationCount || 0,
          clientModified: groupAppts.some(ga => ga.clientModified),
          pendingTime: pendingB1Time, pendingDate: pendingB1Date,
          pendingEndTime: b1.pendingEndTime || (b2 && b2.pendingTime ? b2.pendingEndTime || '' : ''),
          pendingEmployeeId: b1.pendingEmployeeId || '',
          pendingEmployeeName: b1.pendingEmployeeId && empMap[b1.pendingEmployeeId] ? empMap[b1.pendingEmployeeId].name : '',
          pendingSalonConfirm: groupAppts.some(ga => ga.pendingSalonConfirm),
          block2Time: b2 ? b2.time : '', block2EndTime: b2 ? b2.endTime : '',
          block2PendingTime: b2 ? (b2.pendingTime || '') : ''
        });
      } else {
        processed.add(a.id);
        const svcIds = a.serviceIds || (a.serviceId ? [a.serviceId] : []);
        const svcNames = svcIds.map(id => svcMap[id] ? svcMap[id].name : null).filter(Boolean);
        result.push({
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
          pendingEmployeeName: a.pendingEmployeeId && empMap[a.pendingEmployeeId] ? empMap[a.pendingEmployeeId].name : '',
          pendingSalonConfirm: !!a.pendingSalonConfirm
        });
      }
    }
    return json({
      client: { id: client.id, name: client.name, phone: client.phone, email: client.email || '', historialTecnico: client.historialTecnico || '', punctuality: client.punctuality || '' },
      appointments: result
    });
  }

  switch (path) {










    // === SYNC ===
    case '/sync':
    case '/sync/':
    case '/api/sync':
    case '/api/sync/': {
      if (request.method === 'GET') {
        const data = await readData();
        return json(data, 200, { 'Cache-Control': 'no-cache' });
      }
      if (request.method === 'POST') {
        try {
          const remote = await getBody();
          const current = await readData();
          const merged = { ...current };
          const wasCancelledOrDeleted = new Set();
          (current.appointments||[]).forEach(a => { if (a && (a.cancelledBy || a._deleted)) wasCancelledOrDeleted.add(a.id); });
          ['appointments', 'clients', 'services', 'employees', 'products', 'projects', 'movements', 'sections', 'providers'].forEach(k => {
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
          await writeData(merged);
           return json({
             ok: true,
             appointments: (Array.isArray(merged.appointments) ? merged.appointments : []).length,
             clients: (Array.isArray(merged.clients) ? merged.clients : []).length,
             services: (Array.isArray(merged.services) ? merged.services : []).length,
             employees: (Array.isArray(merged.employees) ? merged.employees : []).length,
             lastModified: merged.lastModified
           });
         } catch (e) {
           return json({ error: e.message }, 400);
         }
       }
       return json({ error: 'Method not allowed' }, 405);
     }
 

 
     // === HEALTH ===
     case '/health':
     case '/api/health': {
      const data = await readData();
      return json({
        status: 'ok', storage: 'upstash-redis',
        appointments: (data.appointments || []).length,
        clients: (data.clients || []).length,
        services: (data.services || []).length,
        employees: (data.employees || []).length,
        products: (data.products||[]).length,
        projects: (data.projects||[]).length,
        lastModified: data.lastModified
      });
    }



    // === API: SLOTS ===
    case '/api/slots': {
      const data = await readData();
      const q = url.searchParams;
      const date = q.get('date');
      const serviceIdsParam = q.get('serviceIds') || q.get('serviceId') || '';
      if (!date || !serviceIdsParam) {
        return json({ error: 'date and serviceId(s) required' }, 400);
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
        return json({ slots: [], date, serviceIds, duration: totalDuration, closed: true });
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
      return json({ slots, date, serviceIds, duration: totalDuration });
    }

    // === API: BOOK ===
    case '/api/book': {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      try {
        const b = await getBody();
        const data = await readData();
        const serviceIds = b.serviceIds || (b.serviceId ? [b.serviceId] : []);
        if (!serviceIds.length || !b.date || !b.time || !b.clientName || !b.clientPhone) {
          return json({ error: 'Faltan campos obligatorios' }, 400);
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
            return json({ error: 'Esa hora cae en el horario de descanso del mediodía. Por favor, elige otra hora.' }, 409);
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
              return json({ error: 'Este horario ya no está disponible. '+cli?.name+' tiene cita de '+conflict.time+' a '+(conflict.endTime||'') }, 409);
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
            return json({ error: 'Este horario ya no está disponible. '+cli?.name+' tiene cita de '+conflict.time+' a '+(conflict.endTime||'') }, 409);
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
        return json({ ok: true, appointmentId: 'ok', emailSent: false, cleanedCount, apptTimes });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    // === API: CLIENT ===
    case '/api/client': {
      if (request.method === 'GET') {
        const phone = url.searchParams.get('phone');
        if (!phone) {
          return json({ error: 'phone required' }, 400);
        }
        return handleClientLogin(phone);
      }
      if (request.method === 'POST') {
        try {
          const b = await getBody();
          if (!b.name || !b.phone) {
            return json({ error: 'name and phone required' }, 400);
          }
          const d = await readData();
          if ((d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted)) {
            return json({ error: 'Ya existe un cliente con ese teléfono' }, 409);
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
          return json({ ok: true, client: { id: client.id, name: client.name, phone: client.phone, email: client.email, historialTecnico: client.historialTecnico, punctuality: client.punctuality } });
        } catch (e) {
          return json({ error: e.message }, 400);
        }
      }
      return json({ error: 'Method not allowed' }, 405);
    }

    // === API: CANCEL ===
    case '/api/cancel': {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      try {
        const b = await getBody();
        if (!b.appointmentId || !b.phone) {
          return json({ error: 'appointmentId and phone required' }, 400);
        }
        const d = await readData();
        const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
        if (!client) {
          return json({ error: 'Cliente no encontrado' }, 403);
        }
        const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && (!a._deleted || a.cancelledBy === 'salon'));
        if (!appt) {
          return json({ error: 'Cita no encontrada' }, 404);
        }
        if (appt.source !== 'online') {
          return json({ error: 'Solo puedes cancelar citas creadas online' }, 403);
        }
        if (appt.date < new Date().toISOString().split('T')[0]) {
          return json({ error: 'No puedes cancelar una cita pasada' }, 400);
        }
        const toCancel = appt.blockGroupId ? (d.appointments||[]).filter(a => a.blockGroupId === appt.blockGroupId && !a._deleted) : [appt];
        for (const tc of toCancel) {
          if (tc.cancelledBy === 'salon') {
            tc._deleted = true;
            tc.cancelledBy = '';
          } else {
            tc._deleted = true;
            tc.cancelledBy = 'client';
          }
          tc._modified = Date.now();
        }
        await writeData(d);
        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    // === API: ACCEPT MODIFICATION (salon modifies, client accepts) ===
    case '/api/accept-modification': {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      try {
        const b = await getBody();
        if (!b.appointmentId || !b.phone) {
          return json({ error: 'appointmentId and phone required' }, 400);
        }
        const d = await readData();
        const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
        if (!client) {
          return json({ error: 'Cliente no encontrado' }, 403);
        }
        const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && !a._deleted);
        if (!appt) {
          return json({ error: 'Cita no encontrada' }, 404);
        }
        if (appt.source !== 'online') {
          return json({ error: 'Solo puedes aceptar modificaciones de citas online' }, 403);
        }
        if (!appt.salonModified) {
          return json({ error: 'La cita no tiene modificaciones pendientes' }, 400);
        }
        const groupAppts = appt.blockGroupId ? (d.appointments||[]).filter(a => a.blockGroupId === appt.blockGroupId && !a._deleted) : [appt];
        for (const a of groupAppts) {
          a.salonModified = false;
          a._modified = Date.now();
        }
        const gap = (d.settings && d.settings.bloques && d.settings.bloques.bloqueGap) ? d.settings.bloques.bloqueGap : 45;
        if (groupAppts.length > 1) {
          const b1 = groupAppts.find(x => x.blockNum === '1');
          const b2 = groupAppts.find(x => x.blockNum === '2');
          if (b1 && b2) {
            const b1SvcIds = b1.serviceIds || (b1.serviceId ? [b1.serviceId] : []);
            const b1Svcs = b1SvcIds.map(sid => (d.services||[]).find(s => s.id === sid)).filter(Boolean);
            const b1Dur = b1Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
            const b1EndMin = parseTime(b1.time) * 60 + b1Dur;
            b1.endTime = String(Math.floor(b1EndMin/60)).padStart(2,'0') + ':' + String(b1EndMin%60).padStart(2,'0');
            const b2StartMin = parseTime(b1.time) * 60 + b1Dur + gap;
            b2.time = String(Math.floor(b2StartMin/60)).padStart(2,'0') + ':' + String(b2StartMin%60).padStart(2,'0');
            const b2SvcIds = b2.serviceIds || (b2.serviceId ? [b2.serviceId] : []);
            const b2Svcs = b2SvcIds.map(sid => (d.services||[]).find(s => s.id === sid)).filter(Boolean);
            const b2Dur = b2Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
            const b2EndMin = b2StartMin + b2Dur;
            b2.endTime = String(Math.floor(b2EndMin/60)).padStart(2,'0') + ':' + String(b2EndMin%60).padStart(2,'0');
          }
        }
        await writeData(d);
        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    // === API: MODIFY (client requests modification) ===
    case '/api/modify': {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      try {
        const b = await getBody();
        if (!b.appointmentId || !b.phone || !b.newTime) {
          return json({ error: 'appointmentId, phone, newTime required' }, 400);
        }
        const d = await readData();
        const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
        if (!client) {
          return json({ error: 'Cliente no encontrado' }, 403);
        }
        const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && !a._deleted);
        if (!appt) {
          return json({ error: 'Cita no encontrada' }, 404);
        }
        if (appt.source !== 'online') {
          return json({ error: 'Solo puedes modificar citas creadas online' }, 403);
        }
        const newDate = b.newDate || appt.date;
        const newEmpId = b.newEmployeeId !== undefined ? b.newEmployeeId : appt.employeeId;
        const isBlockGroup = !!appt.blockGroupId;
        const gap = (d.settings && d.settings.bloques && d.settings.bloques.bloqueGap) ? d.settings.bloques.bloqueGap : 45;
        const allApptsToModify = [];
        let block1NewTime = b.newTime;
        let block1NewDate = newDate;
        let block1SrvDuration = 30;
        if (isBlockGroup) {
          const groupAppts = (d.appointments||[]).filter(a => a.blockGroupId === appt.blockGroupId && !a._deleted);
          const b1 = groupAppts.find(a => a.blockNum === '1');
          const b2 = groupAppts.find(a => a.blockNum === '2');
          if (b1) {
            const srv1 = (d.services||[]).find(s => s.id === b1.serviceId);
            block1SrvDuration = srv1 ? (srv1.duration || 30) : 30;
          }
          if (appt.blockNum === '2' && b1) {
            block1NewTime = b.newTime;
            const b1StartMin = parseTime(block1NewTime);
            const b1EndMin = b1StartMin + block1SrvDuration / 60;
            const b2StartMin = b1EndMin + gap;
            const b2H = Math.floor(b2StartMin / 60);
            const b2M = Math.round((b2StartMin - b2H) * 60);
            const b2NewTime = String(b2H).padStart(2,'0') + ':' + String(b2M).padStart(2,'0');
            const srv2 = (d.services||[]).find(s => s.id === (b2 ? b2.serviceId : appt.serviceId));
            const b2Dur = srv2 ? (srv2.duration || 30) : 30;
            const b2EndMin = b2StartMin + b2Dur / 60;
            const b2EndH = Math.floor(b2EndMin / 60);
            const b2EndM = Math.round((b2EndMin - b2EndH) * 60);
            if (b2) {
              allApptsToModify.push({ appt: b2, pendingTime: b2NewTime, pendingDate: newDate, endTime: String(b2EndH).padStart(2,'0') + ':' + String(b2EndM).padStart(2,'0') });
            }
            if (b1) {
              const b1EndH2 = Math.floor(b1EndMin / 60);
              const b1EndM2 = Math.round((b1EndMin - b1EndH2) * 60);
              allApptsToModify.push({ appt: b1, pendingTime: block1NewTime, pendingDate: newDate, endTime: String(b1EndH2).padStart(2,'0') + ':' + String(b1EndM2).padStart(2,'0') });
            }
          } else {
            const b1StartMin = parseTime(b.newTime);
            const b1EndMin = b1StartMin + block1SrvDuration / 60;
            const b1EndH = Math.floor(b1EndMin / 60);
            const b1EndM = Math.round((b1EndMin - b1EndH) * 60);
            allApptsToModify.push({ appt: b1 || appt, pendingTime: b.newTime, pendingDate: newDate, endTime: String(b1EndH).padStart(2,'0') + ':' + String(b1EndM).padStart(2,'0') });
            if (b2) {
              const b2StartMin = b1EndMin + gap;
              const b2H = Math.floor(b2StartMin / 60);
              const b2M = Math.round((b2StartMin - b2H) * 60);
              const b2NewTime = String(b2H).padStart(2,'0') + ':' + String(b2M).padStart(2,'0');
              const srv2 = (d.services||[]).find(s => s.id === b2.serviceId);
              const b2Dur = srv2 ? (srv2.duration || 30) : 30;
              const b2EndMin = b2StartMin + b2Dur / 60;
              const b2EndH = Math.floor(b2EndMin / 60);
              const b2EndM = Math.round((b2EndMin - b2EndH) * 60);
              allApptsToModify.push({ appt: b2, pendingTime: b2NewTime, pendingDate: newDate, endTime: String(b2EndH).padStart(2,'0') + ':' + String(b2EndM).padStart(2,'0') });
            }
          }
        } else {
          const srv = (d.services||[]).find(s => s.id === appt.serviceId);
          const srvDuration = srv ? srv.duration : 30;
          const reqStart = parseTime(b.newTime);
          const reqEnd = reqStart + srvDuration / 60;
          const b1EndH = Math.floor(reqEnd / 60);
          const b1EndM = Math.round((reqEnd - b1EndH) * 60);
          allApptsToModify.push({ appt: appt, pendingTime: b.newTime, pendingDate: newDate, endTime: String(b1EndH).padStart(2,'0') + ':' + String(b1EndM).padStart(2,'0') });
        }
        for (const item of allApptsToModify) {
          const reqStart = parseTime(item.pendingTime);
          const refAppt = item.appt;
          const refSrv = (d.services||[]).find(s => s.id === refAppt.serviceId);
          const refDur = refSrv ? (refSrv.duration || 30) : 30;
          const reqEnd = reqStart + refDur / 60;
          const conflict = (d.appointments||[]).some(a => {
            if (a._deleted || a.id === refAppt.id) return false;
            if (isBlockGroup && allApptsToModify.some(m => m.appt.id === a.id)) return false;
            if (a.date !== item.pendingDate) return false;
            if (a.employeeId && newEmpId && a.employeeId !== newEmpId) return false;
            const as = (d.services||[]).find(s => s.id === a.serviceId);
            const aStart = parseTime(a.time);
            const aEnd = aStart + (as ? (as.duration || 30) : 30) / 60;
            return reqStart < aEnd && reqEnd > aStart;
          });
          if (conflict) {
            return json({ error: 'El nuevo horario no está disponible para el bloque ' + (item.appt.blockNum || '1') }, 409);
          }
        }
        const modTarget = allApptsToModify.find(m => m.appt.id === appt.id) || allApptsToModify[0];
        if ((appt.modificationCount || 0) >= 1) {
          return json({ error: 'Ya has modificado esta cita anteriormente. Solo puedes modificarla una vez.' }, 403);
        }
        for (const item of allApptsToModify) {
          const a = item.appt;
          a.clientModified = true;
          a.pendingDate = item.pendingDate;
          a.pendingTime = item.pendingTime;
          a.pendingEmployeeId = newEmpId;
          if (item.endTime) a.pendingEndTime = item.endTime;
          a._modified = Date.now();
        }
        appt.modificationCount = (appt.modificationCount || 0) + 1;
        await writeData(d);
        return json({ ok: true, appointment: { id: appt.id, pendingDate: modTarget.pendingDate, pendingTime: modTarget.pendingTime } });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    // === API: ACCEPT CLIENT MODIFICATION (salon accepts/rejects) ===
    case '/api/accept-client-modification': {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      try {
        const b = await getBody();
        if (!b.appointmentId || !b.phone) return json({ error: 'appointmentId and phone required' }, 400);
        const d = await readData();
        const client = (d.clients||[]).find(c => normPhone(c.phone) === normPhone(b.phone) && !c._deleted);
        if (!client) return json({ error: 'Cliente no encontrado' }, 403);
        const appt = (d.appointments||[]).find(a => a.id === b.appointmentId && a.clientId === client.id && !a._deleted);
        if (!appt) return json({ error: 'Cita no encontrada' }, 404);
        if (!appt.clientModified) return json({ error: 'La cita no tiene modificaciones pendientes del cliente' }, 400);
        const groupAppts = appt.blockGroupId ? (d.appointments||[]).filter(a => a.blockGroupId === appt.blockGroupId && !a._deleted) : [appt];
        if (b.action === 'accept') {
          for (const a of groupAppts) {
            if (!a.clientModified && !a.pendingTime) continue;
            if (a.pendingDate) a.date = a.pendingDate;
            if (a.pendingTime) a.time = a.pendingTime;
            if (a.pendingEndTime) a.endTime = a.pendingEndTime;
            if (a.pendingEmployeeId) a.employeeId = a.pendingEmployeeId;
            a.clientModified = false;
            delete a.pendingDate;
            delete a.pendingTime;
            delete a.pendingEndTime;
            delete a.pendingEmployeeId;
            a._modified = Date.now();
          }
        } else {
          for (const a of groupAppts) {
            a.clientModified = false;
            delete a.pendingDate;
            delete a.pendingTime;
            delete a.pendingEndTime;
            delete a.pendingEmployeeId;
            a._modified = Date.now();
          }
        }
        await writeData(d);
        return json({ ok: true, appointment: { id: appt.id, date: appt.date, time: appt.time } });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }



    // === API: WEB PRODUCTS ===
    case '/api/web-products': {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (!requireWebAuth(request)) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const d = await readData();
      const webProducts = (d.products||[]).filter(p => (p.showOnWeb || p.showWeb));
      const body = JSON.stringify(webProducts.map(p => ({
        id: p.id, name: p.name || '', price: p.price,
        description: p.description||'', photo: sanitizeUrl(p.photo)
      })));
      const etag = await computeETag(body);
      if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: CORS_HEADERS });
      }
      return json(JSON.parse(body), 200, { 'ETag': etag, 'Cache-Control': 'no-cache' });
    }

    // === API: WEB OFFERS ===
    case '/api/web-offers': {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (!requireWebAuth(request)) {
        return json({ error: 'Unauthorized' }, 401);
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
      const etag = await computeETag(body);
      if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: CORS_HEADERS });
      }
      return json(JSON.parse(body), 200, { 'ETag': etag, 'Cache-Control': 'no-cache' });
    }

    // === API: SYNC PULL ===
    case '/api/sync-pull': {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      return json({ ok: true, message: 'Sync pull triggered (Cloudflare)' });
    }

    // === API: ONLINE STATUS ===
    case '/api/online-status': {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const d = await readData();
      const s = d.settings || {};
      const today = new Date().toISOString().split('T')[0];
      const dayCfg = (s.onlineOpening || {})[today] || {};
      if (dayCfg.time === undefined && dayCfg.enabled === undefined) {
        const oh = getOpeningHoursForDay(today, s);
        return json({
          enabled: !oh.closed,
          openingTime: oh.open < 10 ? '0'+Math.floor(oh.open)+':00' : Math.floor(oh.open)+':00',
          settings: s
        });
      } else {
        return json({
          enabled: dayCfg.enabled !== false,
          openingTime: dayCfg.time || '18:00',
          settings: s
        });
      }
    }







    default:
      return json({ error: 'Not found' }, 404);
  }
  } catch (e) {
    console.error('[CF ERROR]', e.message, e.stack);
    return new Response(JSON.stringify({ error: 'Error interno: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
