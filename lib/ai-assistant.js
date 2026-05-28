const { readData, writeData } = require('./kv-data');
const { sendMessage } = require('./whatsapp');

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const FUNCTION_CALL_RE = /<function=([^>]+)>(.*?)<\/function>/gs;
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

function buildSystemPrompt(data, clientInfo) {
  const services = (data.services||[]).filter(s => !s._deleted).map(s =>
    `- ${s.name} (ID: ${s.id}) (${s.duration||30} min${s.price ? ', '+s.price+'€' : ''})`
  ).join('\n');

  const employees = (data.employees||[]).filter(e => !e._deleted).map(e =>
    `- ${e.name} (ID: ${e.id})`
  ).join('\n');

  const settings = data.settings || {};

  const clientName = clientInfo ? clientInfo.name : null;

  return `Eres ${BUSINESS_NAME}, asistente virtual de ${BUSINESS_NAME}. ${BUSINESS_ADDRESS ? 'Dirección: '+BUSINESS_ADDRESS : ''} ${BUSINESS_PHONE ? 'Teléfono: '+BUSINESS_PHONE : ''}

Eres amable, profesional y respondes SIEMPRE en español.

SERVICIOS DISPONIBLES:
${services || 'No hay servicios configurados'}

EMPLEADOS:
${employees || 'No hay empleados configurados'}

${clientName ? 'DATOS DEL CLIENTE: El cliente se llama '+clientName+'. NO preguntes su nombre ni teléfono.' : 'DATOS DEL CLIENTE: El cliente no está registrado. Cuando quiera reservar, pregúntale su nombre.'}

NORMAS IMPORTANTES:
- Cuando necesites consultar disponibilidad, llamar a una función, usa SIEMPRE el formato: <function=checkAvailability>{"date":"YYYY-MM-DD","serviceId":"id"}</function>
- Para reservar: <function=bookAppointment>{"serviceId":"id","date":"YYYY-MM-DD","time":"HH:MM","employeeId":"id","clientName":"nombre"}</function>
- Para cancelar: <function=cancelAppointment>{"appointmentId":"id"}</function>
- Para modificar: <function=modifyAppointment>{"appointmentId":"id","newTime":"HH:MM"}</function>
- Para citas del cliente: <function=getClientAppointments>{"phone":"teléfono"}</function>
- Para info del negocio: <function=getBusinessInfo>{"dummy":""}</function>
- Si preguntan por disponibilidad, usa checkAvailability
- Para reservar, primero obten disponibilidad, luego pide confirmación, luego usa bookAppointment
- Para cancelar una cita, usa cancelAppointment (necesitas saber cuál)
- Para modificar una cita, primero muestra las citas del cliente con getClientAppointments, luego usa modifyAppointment
- Si preguntan por servicios o precios, usa getBusinessInfo
- SIEMPRE confirma los detalles antes de ejecutar cualquier acción
- Responde de forma natural y conversacional
- NUNCA incluyas etiquetas XML o <function> en tu respuesta normal. Solo usa <function> cuando realmente necesites ejecutar una acción.`;
}

function buildTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'checkAvailability',
        description: 'Consultar disponibilidad (horas libres) para una fecha y servicio opcional',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
            serviceId: { type: 'string', description: 'ID del servicio (opcional)' }
          },
          required: ['date']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'bookAppointment',
        description: 'Reservar una cita. Usa el teléfono del cliente automáticamente.',
        parameters: {
          type: 'object',
          properties: {
            serviceId: { type: 'string', description: 'ID del servicio' },
            date: { type: 'string', description: 'Fecha YYYY-MM-DD' },
            time: { type: 'string', description: 'Hora HH:MM' },
            employeeId: { type: 'string', description: 'ID del empleado' },
            clientName: { type: 'string', description: 'Nombre del cliente' }
          },
          required: ['serviceId', 'date', 'time', 'employeeId', 'clientName']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cancelAppointment',
        description: 'Cancelar una cita existente',
        parameters: {
          type: 'object',
          properties: {
            appointmentId: { type: 'string', description: 'ID de la cita a cancelar' }
          },
          required: ['appointmentId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'modifyAppointment',
        description: 'Modificar una cita existente (cambiar hora/fecha/empleado)',
        parameters: {
          type: 'object',
          properties: {
            appointmentId: { type: 'string', description: 'ID de la cita' },
            newTime: { type: 'string', description: 'Nueva hora HH:MM (opcional)' },
            newDate: { type: 'string', description: 'Nueva fecha YYYY-MM-DD (opcional)' },
            newEmployeeId: { type: 'string', description: 'Nuevo ID de empleado (opcional)' }
          },
          required: ['appointmentId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'getClientAppointments',
        description: 'Obtener las citas del cliente',
        parameters: {
          type: 'object',
          properties: {
            phone: { type: 'string', description: 'Teléfono del cliente' }
          },
          required: ['phone']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'getBusinessInfo',
        description: 'Obtener información del negocio (servicios, precios, horarios)',
        parameters: {
          type: 'object',
          properties: { dummy: { type: 'string', description: 'ignored' } }
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
    max_tokens: 1024
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

      if (r.status === 429) {
        const waitMatch = errText.match(/try again in (\d+(?:\.\d+)?)s/);
        const waitMs = waitMatch ? Math.min(parseFloat(waitMatch[1]) * 1000 + 500, 15000) : 3000;
        console.log(`[GROQ RATE-LIMIT] Esperando ${waitMs}ms antes de reintentar...`);
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
    case 'cancelAppointment': {
      return await cancelAppointment(args.appointmentId, phone, data);
    }
    case 'modifyAppointment': {
      return await modifyAppointment(args, phone, data);
    }
    case 'getClientAppointments': {
      return await getClientAppointments(phone, data);
    }
    case 'getBusinessInfo': {
      return getBusinessInfo(data);
    }
    default:
      return { error: `Unknown tool: ${fn.name}` };
  }
}

async function checkAvailability(date, serviceId, data) {
  const settings = data.settings || {};
  const dayHours = getOpeningHoursForDay(date, settings);
  if (dayHours.closed) return { available: false, message: 'No hay disponibilidad para ese día (cerrado)' };

  const openMin = Math.round(dayHours.open * 60);
  const closeMin = Math.round(dayHours.close * 60);

  const emps = (data.employees||[]).filter(e => !e._deleted);
  if (!emps.length) return { available: false, message: 'No hay empleados disponibles' };

  const services = serviceId
    ? [(data.services||[]).find(s => s.id === serviceId)].filter(Boolean)
    : (data.services||[]).filter(s => !s._deleted);

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
    grouped[key].push(`${s.employeeName} (ID: ${s.employeeId || 'ninguno'})`);
  });

  const slotList = Object.entries(grouped).slice(0, 20).map(([t, emps]) => {
    const unique = [...new Set(emps)];
    return `${t} - ${unique.join(', ')}`;
  });

  return {
    available: true,
    date,
    slots: slotList,
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
    source: 'online',
    status: 'pending',
    notes: clientName ? 'Reservado por WhatsApp por ' + clientName : 'Reservado por WhatsApp',
    created: Date.now(),
    _modified: Date.now(),
    _deleted: false
  };

  data.appointments.push(appt);
  await writeData(data);

  const endH = Math.floor(reqEnd);
  const endM = Math.round((reqEnd - endH) * 60);
  const endTime = String(endH).padStart(2,'0')+':'+String(endM).padStart(2,'0');

  return {
    success: true,
    message: `✅ Cita confirmada:\n📅 ${formatDate(date)}\n⏰ ${time} - ${endTime}\n💇 ${srv.name}\n👤 ${clientName}\n\n¡Te esperamos!`
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

function getBusinessInfo(data) {
  const settings = data.settings || {};
  const services = (data.services||[]).filter(s => !s._deleted).map(s =>
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

  return {
    businessName: BUSINESS_NAME,
    phone: BUSINESS_PHONE,
    address: BUSINESS_ADDRESS,
    info: `📍 ${BUSINESS_NAME}\n📞 ${BUSINESS_PHONE}\n${BUSINESS_ADDRESS ? '\n🏠 '+BUSINESS_ADDRESS : ''}\n\n💇 SERVICIOS:\n${services || 'No hay servicios configurados'}\n\n👥 EMPLEADOS:\n${employees || 'Sin empleados'}\n\n🕐 HORARIOS:\n${schedule}`
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
      history.push({ role: 'assistant', content: `¡Hola! Soy Sara, la asistente virtual de ${BUSINESS_NAME}. ¿En qué puedo ayudarte? Puedo consultar disponibilidad, reservar citas, modificar o cancelar.` });
    }

    history.push({ role: 'user', content: text });

    const maxTurns = 3;
    for (let turn = 0; turn < maxTurns; turn++) {
      const result = await callGroq([
        { role: 'system', content: systemPrompt },
        ...history.slice(-8)
      ], tools);

      if (result.tool_calls) {
        await new Promise(r => setTimeout(r, 1200));
        const toolMessages = [{
          role: 'assistant',
          content: null,
          tool_calls: result.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments }
          }))
        }];

        for (const tc of result.tool_calls) {
          const toolResult = await executeTool(tc, phone, data);
          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult)
          });
        }

        history.push(...toolMessages);
        continue;
      }

      if (result.content) {
        const inlineFns = [...result.content.matchAll(FUNCTION_CALL_RE)];
        if (inlineFns.length > 0) {
          let toolContent = result.content.replace(FUNCTION_CALL_RE, '').trim();
          if (toolContent) {
            history.push({ role: 'assistant', content: toolContent });
          }
          for (const [, fnName, argsStr] of inlineFns) {
            let args = {};
            try { args = JSON.parse(argsStr); } catch {}
            const toolResult = await executeTool({ function: { name: fnName, arguments: argsStr } }, phone, data);
            history.push({ role: 'tool', tool_call_id: fnName + '_' + Date.now(), content: JSON.stringify(toolResult) });
          }
          continue;
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

    const maxTurns = 3;
    for (let turn = 0; turn < maxTurns; turn++) {
      const result = await callGroq([
        { role: 'system', content: systemPrompt },
        ...history.slice(-8)
      ], tools);

      if (result.content) {
        history.push({ role: 'assistant', content: result.content });
        await saveConversation(phone + ':phone', history);
        return result.content;
      }

      if (result.tool_calls) {
        await new Promise(r => setTimeout(r, 1200));
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
