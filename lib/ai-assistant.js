const { readData, writeData } = require('./kv-data');
const { sendMessage } = require('./whatsapp');

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = 'deepseek-chat';
const FUNCTION_CALL_RE = /<function=([^>]+)>(.*?)<\/function>/gs;
const VERCEL_SYNC_URL = process.env.VERCEL_SYNC_URL || 'https://tpv-peluqueria.vercel.app/sync';
const VERCEL_SYNC_KEY = process.env.VERCEL_SYNC_KEY || '';
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Nymara Estilistas';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';
const BUSINESS_ADDRESS = process.env.BUSINESS_ADDRESS || '';

function normPhone(p) {
  const d = (p||'').replace(/[^0-9]/g, '');
  return d.length > 9 ? d.slice(-9) : d;
}

function parseTime(t) {
  if (!t || typeof t !== 'string') return 0;
  const p = t.split(':');
  return (parseInt(p[0])||0) + (parseInt(p[1])||0) / 60;
}

function timeToMinutes(t) {
  const [h,m]=t.split(':').map(Number);
  return h*60+m;
}

function minutesToTime(m) {
  const h = Math.floor(m/60);
  const min = m % 60;
  return String(h).padStart(2,'0')+':'+String(min).padStart(2,'0');
}

function formatDate(iso) {
  if (!iso || typeof iso !== 'string') return iso || '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return parts[2]+'-'+parts[1]+'-'+parts[0];
}

function parseTime(str) {
  const parts = (str || '09:00').split(':');
  return (parseInt(parts[0]) || 9) + (parseInt(parts[1]) || 0) / 60;
}

function getOpeningHoursForDay(dateStr, settings) {
  if (!settings) return { open: 9, close: 19, closed: false };
  const online = settings.onlineOpening?.[dateStr];
  if (online) {
    if (online.enabled === false) return { open: 9, close: 19, closed: true };
    return { open: parseTime(online.time || '09:00'), close: 19, closed: false };
  }
  if (settings.openingHours) {
    const d = new Date(dateStr + 'T12:00:00').getDay();
    const day = settings.openingHours[d];
    if (!day) return { open: 9, close: 19, closed: false };
    return { open: parseTime(day.open), close: parseTime(day.close), closed: day.closed === true };
  }
  return { open: 9, close: 19, closed: false };
}

function buildSystemPrompt(data, clientInfo) {
  const services = (data.services||[]).filter(s => !s._deleted).map(s => {
    const name = s.name.replace(/\.$/, '').trim();
    return `${s.id}: ${name} (${s.duration}min${s.price?', '+s.price+'€':''})`;
  }).join('\n');

  const employees = (data.employees||[]).filter(e => !e._deleted).map(e => `${e.name} (${e.id})`).join(', ');

  const clientName = clientInfo ? clientInfo.name : null;
  const today = new Date().toISOString().split('T')[0];

  return `Eres Sara, asistente de ${BUSINESS_NAME}. ${BUSINESS_PHONE||''}
Hoy es ${today}. Habla español.

CLIENTE: ${clientName || 'Nuevo'}

SERVICIOS:
${services||'Ninguno'}

EMPLEADOS: ${employees||'Nadie'}

INSTRUCCIONES:
- Cliente dice servicio por nombre (ej: "corte de mujer"). Tu buscas su ID en SERVICIOS.
- checkAvailability(ID_del_servicio, fecha): cuando tengas servicio + fecha.
- Muestra huecos al cliente con horas y nombres de empleada. NUNCA digas IDs.
- bookAppointment(ID_servicio, fecha, hora, ID_empleado, nombre_cliente): cuando todo confirmado.
- Busca ID_empleado en EMPLEADOS por nombre (formato: "Nombre (ID)").
- NUNCA digas "reservado" sin bookAppointment exitoso.
- NUNCA menciones IDs al cliente.`;
}

function buildTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'checkAvailability',
        description: 'Consultar disponibilidad para un servicio y fecha concretos',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Fecha YYYY-MM-DD' },
            serviceId: { type: 'string', description: 'ID del servicio. Buscalo en SERVICE_IDS por nombre del servicio que pide el cliente.' }
          },
          required: ['date', 'serviceId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'bookAppointment',
        description: 'Reservar una cita con el cliente',
        parameters: {
          type: 'object',
          properties: {
            serviceId: { type: 'string', description: 'ID del servicio' },
            date: { type: 'string', description: 'Fecha YYYY-MM-DD' },
            time: { type: 'string', description: 'Hora HH:MM' },
            employeeId: { type: 'string', description: 'ID del empleado. Buscalo en EMPLOYEE_IDS por nombre de la empleada.' },
            clientName: { type: 'string', description: 'Nombre del cliente' }
          },
          required: ['serviceId', 'date', 'time', 'employeeId', 'clientName']
        }
      }
    }
  ];
}

async function callGroq(messages, tools, retries = 3) {
  if (!GROQ_API_KEY) return { content: 'Lo siento, el asistente no está configurado. Contacta con el salón directamente.' };

  const body = {
    model: GROQ_MODEL,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.7,
    max_tokens: 512
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (r.ok) {
        const result = await r.json();
        const choice = result.choices?.[0];
        if (!choice) return { content: 'No entendí bien. ¿Puedes repetirlo?' };

        if (choice.finish_reason === 'tool_calls' && choice.message?.tool_calls) {
          return { tool_calls: choice.message.tool_calls, message: choice.message };
        }

        return { content: choice.message?.content || '...' };
      }

      const errText = await r.text();
      console.error('[GROQ ERROR]', r.status, errText);

      if (r.status === 429 || r.status === 413) {
        const waitMatch = errText.match(/try again in (\d+(?:\.\d+)?)s/);
        const waitMs = waitMatch ? parseFloat(waitMatch[1]) * 1000 + 500 : 3000;
        console.log(`[GROQ RATE-LIMIT] Esperando ${Math.round(waitMs)}ms antes de reintentar (intento ${attempt+1}/${retries+1})...`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        return { content: 'Uff, estoy muy ocupada. Espera un momento y vuelve a escribirme.' };
      }

      return { content: 'Error Groq ('+r.status+'): '+errText.substring(0,100) };
    } catch (e) {
      console.error('[GROQ FETCH ERROR]', e.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { content: 'Lo siento, hay un problema de conexión. Inténtalo de nuevo.' };
    }
  }
}

async function callGemini(systemPrompt, messages, tools, retries = 3) {
  if (!GEMINI_API_KEY) return { content: 'Lo siento, el asistente no está configurado. Contacta con el salón directamente.' };

  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content || '' }]
  }));

  const geminiTools = tools ? [{
    function_declarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    }))
  }] : [];

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: geminiTools,
    tool_config: { function_calling_config: { mode: 'AUTO' } },
    generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (r.ok) {
        const result = await r.json();
        const candidate = result.candidates?.[0];
        if (!candidate) return { content: 'No entendí bien. ¿Puedes repetirlo?' };

        const parts = candidate.content?.parts || [];
        const textPart = parts.find(p => p.text);
        const funcParts = parts.filter(p => p.functionCall);

        if (funcParts.length > 0) {
          const tool_calls = funcParts.map(p => ({
            id: 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            type: 'function',
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args || {})
            }
          }));
          return { tool_calls, message: { content: textPart?.text || '' } };
        }

        return { content: textPart?.text || '...' };
      }

      const errText = await r.text();
      console.error('[GEMINI ERROR]', r.status, errText);

      if (r.status === 429) {
        console.log(`[GEMINI RATE-LIMIT] Reintentando en 3s (intento ${attempt+1}/${retries+1})...`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        return { content: 'Uff, estoy muy ocupada. Espera un momento y vuelve a escribirme.' };
      }

      return { content: 'Error Gemini ('+r.status+'): '+errText.substring(0,100) };
    } catch (e) {
      console.error('[GEMINI FETCH ERROR]', e.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { content: 'Lo siento, hay un problema de conexión. Inténtalo de nuevo.' };
    }
  }
}

async function callDeepSeek(messages, tools, retries = 3) {
  if (!DEEPSEEK_API_KEY) return { content: 'Lo siento, el asistente no está configurado. Contacta con el salón directamente.' };

  const body = {
    model: DEEPSEEK_MODEL,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.7,
    max_tokens: 512
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (r.ok) {
        const result = await r.json();
        const choice = result.choices?.[0];
        if (!choice) return { content: 'No entendí bien. ¿Puedes repetirlo?' };

        if (choice.finish_reason === 'tool_calls' && choice.message?.tool_calls) {
          return { tool_calls: choice.message.tool_calls, message: choice.message };
        }

        return { content: choice.message?.content || '...' };
      }

      const errText = await r.text();
      console.error('[DEEPSEEK ERROR]', r.status, errText);

      if (r.status === 429) {
        const waitMatch = errText.match(/try again in (\d+(?:\.\d+)?)s/);
        const waitMs = waitMatch ? parseFloat(waitMatch[1]) * 1000 + 500 : 3000;
        console.log(`[DEEPSEEK RATE-LIMIT] Esperando ${Math.round(waitMs)}ms (intento ${attempt+1}/${retries+1})...`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        return { content: 'Uff, estoy muy ocupada. Espera un momento y vuelve a escribirme.' };
      }

      return { content: 'Error DeepSeek ('+r.status+'): '+errText.substring(0,100) };
    } catch (e) {
      console.error('[DEEPSEEK FETCH ERROR]', e.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { content: 'Lo siento, hay un problema de conexión. Inténtalo de nuevo.' };
    }
  }
}

async function executeTool(toolCall, phone, data) {
  const fn = toolCall.function;
  let args = {};

  try {
    args = JSON.parse(fn.arguments || '{}');
  } catch {
    return { error: 'Invalid arguments' };
  }

  console.log('[TOOL]', fn.name, args);

  switch (fn.name) {
    case 'checkAvailability': {
      return await checkAvailability(args.date, args.serviceId, data);
    }
    case 'bookAppointment': {
      return await bookAppointment(args, phone, data);
    }
    default:
      return { error: `Unknown tool: ${fn.name}` };
  }
}

async function checkAvailability(date, serviceId, data) {
  if (!date || !serviceId) return { error: 'Debes especificar servicio y fecha' };

  const settings = data.settings || {};
  const dayHours = getOpeningHoursForDay(date, settings);
  if (dayHours.closed) return { available: false, message: 'No hay disponibilidad para ese día (cerrado)' };

  const openMin = Math.round(dayHours.open * 60);
  const closeMin = Math.round(dayHours.close * 60);

  const emps = (data.employees||[]).filter(e => !e._deleted);
  if (!emps.length) return { available: false, message: 'No hay empleados disponibles' };

  const services = [(data.services||[]).find(s => s.id === serviceId)].filter(Boolean);
  if (!services.length) return { error: `Servicio no encontrado: ${serviceId}` };

  const slots = [];
  for (const emp of emps) {
    const appointments = (data.appointments||[]).filter(a =>
      !a._deleted && a.date === date && a.employeeId === emp.id
    );

    for (const svc of services) {
      const dur = svc.duration || 30;
      let time = openMin;
      while (time + dur <= closeMin) {
        const tStr = minutesToTime(time);
        const aEnd = time + dur;
        const conflict = appointments.some(a => {
          const aSvc = (data.services||[]).find(s => s.id === a.serviceId);
          const aStart = timeToMinutes(a.time);
          const aEndTime = aStart + (aSvc ? (aSvc.duration||30) : 30);
          return time < aEndTime && aEnd > aStart;
        });
        if (!conflict) {
          slots.push({ time: tStr, employeeId: emp.id, employeeName: emp.name, serviceName: svc.name });
        }
        time += 15;
      }
    }
  }

  if (slots.length === 0) return { available: false, message: 'No hay huecos disponibles para ese día' };

  const grouped = {};
  slots.forEach(s => {
    const key = s.time;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(s.employeeName);
  });

  const slotList = Object.entries(grouped).slice(0, 20).map(([t, emps]) => {
    const unique = [...new Set(emps)];
    return `${t} - ${unique.join(', ')}`;
  });

  const slotData = Object.entries(grouped).slice(0, 20).map(([t, _]) => {
    const atTime = slots.filter(s => s.time === t);
    return { time: t, employees: atTime.map(s => ({ name: s.employeeName, id: s.employeeId })) };
  });

  return {
    available: true,
    date,
    slots: slotList,
    slotData,
    message: `Huecos disponibles para ${formatDate(date)}:\n${slotList.join('\n')}`
  };
}

async function bookAppointment(args, phone, data) {
  const { serviceId, date, time, employeeId, clientName } = args;

  const srv = (data.services||[]).find(s => s.id === serviceId);
  if (!srv) return { error: 'Servicio no encontrado' };

  const dur = srv.duration || 30;
  const reqStart = parseTime(time);
  const reqEnd = reqStart + dur / 60;

  const conflict = (data.appointments||[]).some(a =>
    !a._deleted && a.date === date && a.employeeId === employeeId && (() => {
      const as = (data.services||[]).find(s => s.id === a.serviceId);
      const aStart = parseTime(a.time);
      const aEnd = aStart + (as ? (as.duration || 30) : 30) / 60;
      return reqStart < aEnd && reqEnd > aStart;
    })()
  );

  if (conflict) return { error: 'Ese horario ya no está disponible. Prueba otra hora.' };

  let client = (data.clients||[]).find(c => normPhone(c.phone) === normPhone(phone) && !c._deleted);
  const isNewClient = !client;

  if (isNewClient) {
    client = {
      id: 'c'+Date.now().toString(36)+Math.random().toString(36).substr(2,4),
      name: (clientName||'Cliente WhatsApp').trim(),
      phone: phone,
      email: '',
      source: 'whatsapp',
      created: Date.now(),
      _modified: Date.now(),
      _deleted: false
    };
    data.clients.push(client);
  }

  const appt = {
    id: 'a'+Date.now().toString(36)+Math.random().toString(36).substr(2,4),
    clientId: client.id,
    serviceId,
    serviceIds: [serviceId],
    employeeId,
    date,
    time,
    endTime: minutesToDateEnd(time, dur),
    source: 'whatsapp',
    status: 'pending',
    notes: clientName ? 'PENDIENTE - Reservado por WhatsApp por ' + clientName : 'PENDIENTE - Reservado por WhatsApp',
    created: Date.now(),
    _modified: Date.now(),
    _deleted: false,
    pendingSalonConfirm: true
  };

  data.appointments.push(appt);
  await writeData(data);
  forwardToVercel({ appointments: [appt], clients: isNewClient ? [client] : [] });

  const endH = Math.floor(reqEnd);
  const endM = Math.round((reqEnd - endH) * 60);
  const endTime = String(endH).padStart(2,'0')+':'+String(endM).padStart(2,'0');

  return {
    success: true,
    message: `⏳ Solicitud enviada:\n📅 ${formatDate(date)}\n⏰ ${time} - ${endTime}\n💇 ${srv.name}\n👤 ${clientName}\n\nEl salón debe confirmar tu cita. Te avisaremos por WhatsApp cuando esté aprobada.`
  };
}

function minutesToDateEnd(time, duration) {
  const m = timeToMinutes(time) + duration;
  return minutesToTime(m);
}

async function cancelAppointment(appointmentId, phone, data) {
  const appt = (data.appointments||[]).find(a => a.id === appointmentId && !a._deleted);
  if (!appt) return { error: 'Cita no encontrada' };

  const client = (data.clients||[]).find(c => c.id === appt.clientId);
  if (client && normPhone(client.phone) !== normPhone(phone)) {
    return { error: 'Esta cita no pertenece a este teléfono' };
  }

  appt._deleted = true;
  appt.cancelledBy = 'client';
  appt._modified = Date.now();
  await writeData(data);
  forwardToVercel({ appointments: [appt], clients: [] });

  return { success: true, message: '✅ Cita cancelada correctamente. Si quieres reservar otra, dímelo.' };
}

async function modifyAppointment(args, phone, data) {
  const { appointmentId, newTime, newDate, newEmployeeId } = args;
  const appt = (data.appointments||[]).find(a => a.id === appointmentId && !a._deleted);
  if (!appt) return { error: 'Cita no encontrada' };

  const client = (data.clients||[]).find(c => c.id === appt.clientId);
  if (client && normPhone(client.phone) !== normPhone(phone)) {
    return { error: 'Esta cita no pertenece a este teléfono' };
  }

  if (newDate) appt.pendingDate = newDate;
  if (newTime) appt.pendingTime = newTime;
  if (newEmployeeId) appt.pendingEmployeeId = newEmployeeId;
  appt.clientModified = true;
  appt.modificationCount = (appt.modificationCount || 0) + 1;
  appt._modified = Date.now();
  appt.notes = (appt.notes||'') + ' [Modificada por WhatsApp]';
  await writeData(data);
  forwardToVercel({ appointments: [appt], clients: [] });

  const details = [];
  if (newDate || newTime) details.push(`Nuevo horario: ${formatDate(newDate||appt.date)} ${newTime||appt.time}`);
  if (newEmployeeId) {
    const emp = (data.employees||[]).find(e => e.id === newEmployeeId);
    details.push(`Nuevo empleado: ${emp ? emp.name : newEmployeeId}`);
  }

  return { success: true, message: '✅ Solicitud de modificación enviada. El salón la revisará y confirmará.\n\n' + details.join('\n') };
}

async function getClientAppointments(phone, data) {
  const clients = (data.clients||[]).filter(c => normPhone(c.phone) === normPhone(phone) && !c._deleted);
  if (!clients.length) return { appointments: [], message: 'No tienes citas próximas.' };

  const clientIds = new Set(clients.map(c => c.id));
  const today = new Date().toISOString().split('T')[0];
  const appts = (data.appointments||[]).filter(a =>
    clientIds.has(a.clientId) && a.date >= today && !a._deleted
  ).sort((a,b) => (a.date+' '+a.time).localeCompare(b.date+' '+b.time));

  if (!appts.length) return { appointments: [], message: 'No tienes citas próximas.' };

  const empMap = {}; (data.employees||[]).forEach(e => empMap[e.id] = e.name);
  const svcMap = {}; (data.services||[]).forEach(s => svcMap[s.id] = s.name);

  const list = appts.map(a => {
    const svcName = svcMap[a.serviceId] || 'Servicio';
    const empName = empMap[a.employeeId] || '';
    return `🔹 ${formatDate(a.date)} ${a.time}${a.endTime ? '-'+a.endTime : ''} - ${svcName}${empName ? ' con '+empName : ''} (ID: ${a.id})`;
  }).join('\n');

  return {
    appointments: appts.map(a => a.id),
    message: `Tus citas próximas:\n${list}\n\nSi quieres cancelar o modificar alguna, dime el ID.`
  };
}

function getBusinessInfo(data, sectionId) {
  const settings = data.settings || {};

  let services = (data.services||[]).filter(s => !s._deleted);
  let sectionName = '';

  if (sectionId) {
    const section = (data.sections||[]).find(s => s.id === sectionId && !s._deleted);
    sectionName = section ? section.name : '';
    services = services.filter(s => s.sectionId === sectionId);
  }

  const svcList = services.map(s =>
    `• ${s.name} (ID: ${s.id})${s.price ? ' - '+s.price+'€' : ''} (${s.duration||30} min)`
  ).join('\n');

  const employees = (data.employees||[]).filter(e => !e._deleted).map(e =>
    `• ${e.name} (ID: ${e.id})`
  ).join('\n');

  const schedule = settings.onlineOpening ? Object.entries(settings.onlineOpening).slice(0, 7).map(([day, cfg]) => {
    const days = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const d = new Date(day);
    const dayName = days[d.getDay()] || day;
    return `${dayName} (${formatDate(day)}): ${cfg.time||'09:00'} - ${cfg.enabled === false ? 'Cerrado' : 'Abierto'}`;
  }).join('\n') : 'Consultar horarios';

  const header = sectionName ? `📍 ${BUSINESS_NAME} - ${sectionName}` : `📍 ${BUSINESS_NAME}`;

  return {
    businessName: BUSINESS_NAME,
    phone: BUSINESS_PHONE,
    address: BUSINESS_ADDRESS,
    sectionName,
    info: `${header}\n📞 ${BUSINESS_PHONE}\n${BUSINESS_ADDRESS ? '\n🏠 '+BUSINESS_ADDRESS : ''}\n\n💇 SERVICIOS${sectionName ? ' de '+sectionName : ''}:\n${svcList || 'No hay servicios en esta sección'}\n\n👥 EMPLEADOS:\n${employees || 'Sin empleados'}\n\n🕐 HORARIOS:\n${schedule}`
  };
}

async function processWhatsAppMessage(phone, text) {
  try {
    const data = await readData();
    const clients = (data.clients||[]).filter(c => normPhone(c.phone) === normPhone(phone) && !c._deleted);
    const clientInfo = clients.length > 0 ? clients[0] : null;

    const systemPrompt = buildSystemPrompt(data, clientInfo);
    const tools = buildTools();

    const { loadConversation, saveConversation } = require('./conversation');
    let history = await loadConversation(phone);
    if (history.length === 0) {
      history.push({ role: 'assistant', content: `¡Hola! Soy Sara, la asistente virtual de ${BUSINESS_NAME}. ¿En qué puedo ayudarte? Puedo consultar disponibilidad, reservar citas, modificar o cancelar.\n\nPara empezar, dime qué servicio te interesa y qué día te gustaría venir.` });
    }

    history.push({ role: 'user', content: text });
    await saveConversation(phone, history);

    const maxTurns = 3;
    for (let turn = 0; turn < maxTurns; turn++) {
      const ctx = [...history.slice(-4)];
      let result;
      let triedDeepSeek = false;

      if (DEEPSEEK_API_KEY) {
        result = await callDeepSeek([{ role: 'system', content: systemPrompt }, ...ctx], tools);
        if (result.content && result.content.includes('Insufficient Balance')) {
          console.log('[DEEPSEEK] Sin saldo, cayendo a Groq');
          result = await callGroq([{ role: 'system', content: systemPrompt }, ...ctx], tools);
          triedDeepSeek = true;
        }
      } else if (GROQ_API_KEY) {
        result = await callGroq([{ role: 'system', content: systemPrompt }, ...ctx], tools);
      } else if (GEMINI_API_KEY) {
        result = await callGemini(systemPrompt, ctx, tools);
      } else {
        return 'Lo siento, no hay IA configurada. Contacta con el salón directamente.';
      }

      if (result.tool_calls) {
        history.push({ role: 'assistant', content: result.message?.content || null, tool_calls: result.tool_calls });
        const toolMessages = [];

        for (const tc of result.tool_calls) {
          const toolResult = await executeTool(tc, phone, data);
          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult)
          });
        }
        history.push(...toolMessages);
        await new Promise(r => setTimeout(r, 5000));
        let secondResult;
        if (DEEPSEEK_API_KEY) {
          secondResult = await callDeepSeek([{ role: 'system', content: systemPrompt }, ...history.slice(-6)], tools);
        } else if (GROQ_API_KEY) {
          secondResult = await callGroq([{ role: 'system', content: systemPrompt }, ...history.slice(-6)], tools);
        } else if (GEMINI_API_KEY) {
          secondResult = await callGemini(systemPrompt, history.slice(-6), tools);
        } else {
          secondResult = { content: 'Lo siento, no hay IA configurada.' };
        }
        if (secondResult.content && !secondResult.content.startsWith('Error') && !secondResult.content.startsWith('Lo siento')) {
          const clean = secondResult.content.trim() || 'Entendido. ¿Qué más necesitas?';
          history.push({ role: 'assistant', content: clean });
          await saveConversation(phone, history);
          return clean;
        }
        history.push({ role: 'assistant', content: 'Perdona, no he entendido bien. ¿Puedes repetirlo?' });
        await saveConversation(phone, history);
        return 'Perdona, no he entendido bien. ¿Puedes repetirlo?';
      }

      if (result.content) {
        if (result.content.startsWith('Error') || result.content.startsWith('Lo siento, el asistente no está configurado') || result.content.startsWith('Uff, estoy muy ocupada') || result.content.startsWith('Lo siento, hay un problema')) {
          const fallback = 'Perdona, no he entendido bien. ¿Puedes repetirlo?';
          history.push({ role: 'assistant', content: fallback });
          await saveConversation(phone, history);
          return fallback;
        }
        const clean = result.content.trim() || 'Entendido. ¿Qué más necesitas?';
        history.push({ role: 'assistant', content: clean });
        await saveConversation(phone, history);
        return clean;
      }

      history.push({ role: 'assistant', content: 'No entendí bien. ¿Puedes repetirlo?' });
      await saveConversation(phone, history);
      return 'No entendí bien. ¿Puedes repetirlo?';
    }

    history.push({ role: 'assistant', content: 'La conversación es muy larga. Empecemos de nuevo. ¿Qué necesitas?' });
    await saveConversation(phone, history);
    return 'La conversación es muy larga. Empecemos de nuevo. ¿Qué necesitas?';

  } catch (e) {
    console.error('[AI ASSISTANT ERROR]', e.message);
    return 'Lo siento, hubo un error. Inténtalo de nuevo o llama al '+BUSINESS_PHONE;
  }
}

async function processPhoneMessage(phone, text) {
  try {
    const data = await readData();
    const clients = (data.clients||[]).filter(c => normPhone(c.phone) === normPhone(phone) && !c._deleted);
    const clientInfo = clients.length > 0 ? clients[0] : null;

    const systemPrompt = buildSystemPrompt(data, clientInfo);
    const tools = buildTools();
    const { loadConversation, saveConversation } = require('./conversation');
    let history = await loadConversation(phone + ':phone');
    if (history.length === 0) {
      history.push({ role: 'assistant', content: `Hola, soy Sara de ${BUSINESS_NAME}. ¿En qué puedo ayudarte?` });
    }
    history.push({ role: 'user', content: text });

    const maxTurns = 2;
    for (let turn = 0; turn < maxTurns; turn++) {
      const ctx = history.slice(-4);
      let result;
      if (DEEPSEEK_API_KEY) {
        result = await callDeepSeek([{ role: 'system', content: systemPrompt }, ...ctx], tools);
      } else if (GROQ_API_KEY) {
        result = await callGroq([{ role: 'system', content: systemPrompt }, ...ctx], tools);
      } else if (GEMINI_API_KEY) {
        result = await callGemini(systemPrompt, ctx, tools);
      } else {
        return 'Lo siento, no hay IA configurada. Contacta con el salón directamente.';
      }

      if (result.content) {
        if (result.content.startsWith('Error Groq') || result.content.startsWith('Lo siento, el asistente no está configurado') || result.content.startsWith('Uff, estoy muy ocupada') || result.content.startsWith('Lo siento, hay un problema')) {
          history.push({ role: 'assistant', content: 'Perdona, no he entendido bien. ¿Puedes repetirlo?' });
          await saveConversation(phone + ':phone', history);
          return 'Perdona, no he entendido bien. ¿Puedes repetirlo?';
        }
        const inlineFns = [...result.content.matchAll(FUNCTION_CALL_RE)];
        if (inlineFns.length > 0) {
          for (const [, fnName, argsStr] of inlineFns) {
            const toolResult = await executeTool({ function: { name: fnName, arguments: argsStr } }, phone, data);
            history.push({ role: 'tool', tool_call_id: fnName + '_' + Date.now(), content: JSON.stringify(toolResult) });
          }
          continue;
        }
        history.push({ role: 'assistant', content: result.content });
        await saveConversation(phone + ':phone', history);
        return result.content;
      }

      if (result.tool_calls) {
        const toolMessages = [{
          role: 'assistant', content: null,
          tool_calls: result.tool_calls.map(tc => ({
            id: tc.id, type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments }
          }))
        }];
        for (const tc of result.tool_calls) {
          const toolResult = await executeTool(tc, phone, data);
          toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        }
        history.push(...toolMessages);
        await new Promise(r => setTimeout(r, 2500));
      } else {
        history.push({ role: 'assistant', content: 'No entendí bien. ¿Puedes repetirlo?' });
        await saveConversation(phone + ':phone', history);
        return 'No entendí bien. ¿Puedes repetirlo?';
      }
    }
    return 'La conversación es muy larga. Empecemos de nuevo. ¿Qué necesitas?';
  } catch (e) {
    console.error('[PHONE AI ERROR]', e.message);
    return 'Lo siento, hubo un error. Llámanos al '+BUSINESS_PHONE+'.';
  }
}

async function processAudioMessage(phone, media) {
  try {
    const { sendMessage } = require('./whatsapp');
    await sendMessage(phone, 'Prefiero que me escribas el texto. 😊 ¿Qué necesitas?');
  } catch {}
}

async function forwardToVercel(payload) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (VERCEL_SYNC_KEY) headers['Authorization'] = 'Bearer ' + VERCEL_SYNC_KEY;
    const url = VERCEL_SYNC_URL.replace(/\/+$/, '') + '/sync';
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      console.log('[FORWARD] Cita enviada a Vercel OK');
    } else {
      console.warn('[FORWARD] Vercel returned', res.status);
    }
  } catch (e) {
    console.error('[FORWARD] Error:', e.message);
  }
}

module.exports = {
  processWhatsAppMessage,
  processPhoneMessage,
  processAudioMessage,
  buildSystemPrompt,
  buildTools,
  callGroq,
  executeTool,
  checkAvailability,
  bookAppointment,
  cancelAppointment,
  modifyAppointment,
  getClientAppointments,
  getBusinessInfo,
  normPhone
};
