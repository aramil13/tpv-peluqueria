console.log('[AI-ASSISTANT] Cargando ai-assistant.js (GitHub Models solo)');
const { readData, writeData } = require('./kv-data');
const { sendMessage } = require('./whatsapp');

const env = globalThis.__ENV || process.env;

const GITHUB_TOKEN = env.GITHUB_TOKEN || '';

console.log('[AI-ASSISTANT] GitHub Token=' + (GITHUB_TOKEN ? 'SET (' + GITHUB_TOKEN.substring(0, 8) + '...)' : 'VACIA'));
const GITHUB_MODEL = 'gpt-4o-mini';
const FUNCTION_CALL_RE = /<function=([^>]+)>(.*?)<\/function>/gs;
const SYNC_URL = env.SYNC_URL || env.VERCEL_SYNC_URL || env.SYNC_FORWARD_URL || 'https://nymaraestilistas.es/api';
const SYNC_KEY = env.SYNC_KEY || env.VERCEL_SYNC_KEY || '';
const BUSINESS_NAME = env.BUSINESS_NAME || 'Nymara Estilistas';
const BUSINESS_PHONE = env.BUSINESS_PHONE || '';
const BUSINESS_ADDRESS = env.BUSINESS_ADDRESS || '';

function truncateStr(s, maxLen = 2000) {
  if (typeof s !== 'string') return JSON.stringify(s).substring(0, maxLen);
  return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
}

function safeHistorySlice(history, count) {
  let safe = history.slice(-count);
  let fixed = false;
  for (let i = 0; i < safe.length; i++) {
    if (safe[i].role === 'tool') {
      const hasPreceding = safe.slice(0, i).some(m => m.tool_calls && m.tool_calls.some(tc => tc.id === safe[i].tool_call_id));
      if (!hasPreceding) {
        const tcIdx = history.indexOf(safe[i]) - 1;
        if (tcIdx >= 0 && history[tcIdx] && history[tcIdx].tool_calls) {
          safe = [history[tcIdx], ...safe];
          fixed = true;
        }
      }
    }
  }
  if (fixed) return safe;
  if (safe.length && safe[0].role === 'tool') {
    const tcIdx = history.length - count - 1;
    if (tcIdx >= 0 && history[tcIdx] && history[tcIdx].tool_calls) {
      return [history[tcIdx], ...safe];
    }
  }
  return safe;
}

function normPhone(p) {
  const d = (p||'').replace(/[^0-9]/g, '');
  return d.length > 9 ? d.slice(-9) : d;
}

function parseTime(str) {
  const parts = (str || '09:00').split(':');
  return (parseInt(parts[0]) || 9) + (parseInt(parts[1]) || 0) / 60;
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

function isDatePast(dateStr) {
  if (!dateStr) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const p = dateStr.split('-');
  if (p.length !== 3) return false;
  const d = new Date(+p[0], +p[1]-1, +p[2]);
  return d < today;
}

function formatDate(iso) {
  if (!iso || typeof iso !== 'string') return iso || '';
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  return parts[2]+'-'+parts[1]+'-'+parts[0];
}

const DEFAULT_HOURS = {
  "0": { open: "09:00", close: "14:00", closed: true },
  "1": { open: "09:00", close: "14:00", closed: true },
  "2": { open: "09:30", close: "20:30", closed: false, breakStart: "13:30", breakEnd: "15:00" },
  "3": { open: "09:30", close: "20:30", closed: false, breakStart: "13:30", breakEnd: "15:00" },
  "4": { open: "09:30", close: "20:30", closed: false, breakStart: "13:30", breakEnd: "15:00" },
  "5": { open: "09:30", close: "20:30", closed: false, breakStart: "13:30", breakEnd: "15:00" },
  "6": { open: "09:30", close: "14:00", closed: false }
};

function getOpeningHoursForDay(dateStr, settings) {
  const hours = (settings && settings.openingHours) || DEFAULT_HOURS;
  const online = settings?.onlineOpening?.[dateStr];
  if (online) {
    if (online.enabled === false) return { open: parseTime("09:00"), close: parseTime("20:30"), closed: true, breakStart: null, breakEnd: null };
    const dayHours = hours[new Date(dateStr + 'T12:00:00').getDay()] || { open: "09:00", close: "20:30" };
    return { open: parseTime(online.time || dayHours.open), close: parseTime(dayHours.close), closed: false, breakStart: null, breakEnd: null };
  }
  const d = new Date(dateStr + 'T12:00:00').getDay();
  const day = hours[d] || { open: "09:00", close: "20:30", closed: false };
  let breakStart = day.breakStart ? parseTime(day.breakStart) : null;
  let breakEnd = day.breakEnd ? parseTime(day.breakEnd) : null;
  if (breakStart === null && day.morningClose && day.afternoonOpen) {
    const mc = parseTime(day.morningClose);
    const ao = parseTime(day.afternoonOpen);
    if (ao > mc) { breakStart = mc; breakEnd = ao; }
  }
  return {
    open: parseTime(day.open),
    close: parseTime(day.close),
    closed: day.closed === true,
    breakStart,
    breakEnd
  };
}

function buildSystemPrompt(data, clientInfo) {
  const clientName = clientInfo ? clientInfo.name : null;
  const today = new Date().toISOString().split('T')[0];

  const hours = (data.settings && data.settings.openingHours) || DEFAULT_HOURS;
  const DAY_NAMES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const dayRanges = [];
  let currentGroup = null;
  for (let d = 0; d <= 6; d++) {
    const day = hours[d] || { open: '09:00', close: '20:30', closed: false };
    if (day.closed) { currentGroup = null; continue; }
    const hasBreak = (day.breakStart && day.breakEnd) || (day.morningClose && day.afternoonOpen && day.morningClose !== day.afternoonOpen);
    const key = hasBreak ? `${day.open}-${day.morningClose||day.breakStart}|${day.afternoonOpen||day.breakEnd}-${day.close}` : `${day.open}-${day.close}`;
    if (currentGroup && currentGroup.key === key) { currentGroup.end = d; }
    else { currentGroup = { key, start: d, end: d, hasBreak, open: day.open, close: day.close, breakStart: day.breakStart||day.morningClose, breakEnd: day.breakEnd||day.afternoonOpen }; dayRanges.push(currentGroup); }
  }
  const hoursStr = dayRanges.map(g => {
    const days = g.start === g.end ? DAY_NAMES[g.start] : `${DAY_NAMES[g.start]} a ${DAY_NAMES[g.end]}`;
    if (g.hasBreak) return `${days}: ${g.open} - ${g.breakStart} y ${g.breakEnd} - ${g.close}`;
    return `${days}: ${g.open} - ${g.close}`;
  }).join('. ');

  return `Eres Sara, asistente de ${BUSINESS_NAME}. Hoy ${today}. ${hoursStr}.

CLIENTE: ${clientName || 'Nuevo'}

REGLAS ESTRICTAS:
1. NUNCA menciones servicios sin searchService(). NUNCA uses tu conocimiento. searchService da 1 servicio.
2. MULTISERVICIO: searchService de cada uno, luego UNA llamada checkAvailability(date, serviceId=ID1, extraServiceIds=[ID2,ID3]). UNA lista de huecos. Pregunta UNA hora y UN empleado.
3. NUNCA "reservado"/"confirmado". Siempre "solicitud enviada"/"pendiente".
4. NUNCA preguntes teléfono ni muestres IDs.
5. NUNCA inventes IDs de servicio. Usa SOLO los de searchService.
6. cancelAppointment(appointmentIds:[id1,id2]) para varias citas.`;
}

function buildTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'searchService',
        description: 'Buscar servicios por nombre parcial (ej: "corte", "mechas", "color")',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Texto a buscar en el nombre del servicio' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'checkAvailability',
        description: 'Disponibilidad para varios servicios. LLAMADA ÚNICA con serviceId=1er servicio + extraServiceIds=resto.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Fecha YYYY-MM-DD' },
            serviceId: { type: 'string', description: 'ID del primer servicio' },
            extraServiceIds: { type: 'array', items: { type: 'string' }, description: 'IDs del resto de servicios' }
          },
          required: ['date', 'serviceId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'bookAppointment',
        description: 'Reservar una cita con el cliente. OBLIGATORIO: llama a searchService() primero para obtener los IDs. NO inventes IDs.',
        parameters: {
          type: 'object',
          properties: {
            serviceIds: { type: 'array', items: { type: 'string' }, description: 'Array de IDs de searchService(). NUNCA inventes IDs.' },
            date: { type: 'string', description: 'Fecha YYYY-MM-DD' },
            time: { type: 'string', description: 'Hora HH:MM' },
            employeeId: { type: 'string', description: 'ID del empleado' },
            clientName: { type: 'string', description: 'Nombre del cliente' }
          },
          required: ['serviceIds', 'date', 'time', 'employeeId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'getMyAppointments',
        description: 'Obtener las citas próximas del cliente. Devuelve lista con IDs, fechas, servicios y empleados.',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cancelAppointment',
        description: 'Cancelar una o varias citas del cliente. Usa appointmentIds (array) para múltiples citas, o appointmentId (string) para una sola.',
        parameters: {
          type: 'object',
          properties: {
            appointmentId: { type: 'string', description: 'ID de una sola cita a cancelar (alternativa a appointmentIds)' },
            appointmentIds: { type: 'array', items: { type: 'string' }, description: 'Array de IDs de citas a cancelar (úsa este para cancelar varias a la vez)' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'modifyAppointment',
        description: 'Solicitar modificación de una cita (cambiar fecha, hora o empleado)',
        parameters: {
          type: 'object',
          properties: {
            appointmentId: { type: 'string', description: 'ID de la cita a modificar' },
            newDate: { type: 'string', description: 'Nueva fecha YYYY-MM-DD (opcional si solo cambia hora)' },
            newTime: { type: 'string', description: 'Nueva hora HH:MM (opcional si solo cambia fecha)' },
            newEmployeeId: { type: 'string', description: 'Nuevo ID de empleado (opcional)' }
          },
          required: ['appointmentId']
        }
      }
    }
  ];
}

async function callGroq(systemPrompt, messages, tools, retries = 3) {
  if (!GROQ_API_KEY) return { content: 'Lo siento, el asistente no está configurado. Contacta con el salón directamente.' };

  const body = {
    model: GROQ_MODEL,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
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

        const content = choice.message?.content || '';
        const inlineFns = [...content.matchAll(FUNCTION_CALL_RE)];
        if (inlineFns.length > 0) {
          return {
            tool_calls: inlineFns.map(([, fnName, argsStr]) => ({
              id: 'call_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
              type: 'function',
              function: { name: fnName, arguments: (argsStr||'{}').trim() || '{}' }
            })),
            message: { role: 'assistant', content: null }
          };
        }

        return { content };
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

      return { content: 'Lo siento, el servicio de inteligencia artificial no está disponible ahora. Inténtalo de nuevo o llama al salón.' };
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

async function callGemini(systemPrompt, messages, tools, retries = 5) {
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

      if (r.status === 429 || r.status === 503) {
        const delay = r.status === 429 ? 3000 : 2000;
        console.log(`[GEMINI ${r.status === 429 ? 'RATE-LIMIT' : 'UNAVAILABLE'}] Reintentando en ${delay}ms (intento ${attempt+1}/${retries+1})...`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return { content: r.status === 429 ? 'Uff, estoy muy ocupada. Espera un momento y vuelve a escribirme.' : 'El servicio de IA está temporalmente sobrecargado. Inténtalo de nuevo en unos segundos.' };
      }

      return { content: 'Lo siento, el servicio de inteligencia artificial no está disponible ahora. Inténtalo de nuevo o llama al salón.' };
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

      if (r.status === 429 || errText.includes('rate_limit')) {
        const waitMatch = errText.match(/try again in (\d+(?:\.\d+)?)s/);
        const waitMs = waitMatch ? parseFloat(waitMatch[1]) * 1000 + 500 : 3000;
        console.log(`[DEEPSEEK RATE-LIMIT] Esperando ${Math.round(waitMs)}ms (intento ${attempt+1}/${retries+1})...`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        return { content: 'Uff, estoy muy ocupada. Espera un momento y vuelve a escribirme.' };
      }

      if (r.status === 401 || r.status === 402 || errText.includes('invalid_api_key') || errText.includes('insufficient') || errText.includes('balance') || errText.includes('quota')) {
        return { content: '⚠️ La API Key de DeepSeek no es válida o no tiene saldo. Ve a https://platform.deepseek.com y revisa tu cuenta.' };
      }

      return { content: 'Lo siento, el servicio de inteligencia artificial no está disponible ahora. Inténtalo de nuevo o llama al salón.' };
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

function getGitHubToken() { return (globalThis.__ENV || process.env).GITHUB_TOKEN || ''; }

async function callGitHubModels(systemPrompt, messages, tools, retries = 8) {
  const token = getGitHubToken();
  if (!token) return { content: 'Lo siento, el asistente no está configurado. Contacta con el salón directamente.' };

  const body = {
    model: GITHUB_MODEL,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    tools,
    tool_choice: 'auto',
    temperature: 0.7,
    max_tokens: 1024
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch('https://models.inference.ai.azure.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
      console.error('[GITHUB MODELS ERROR]', r.status, errText.startsWith('{') ? '(JSON)' : errText, errText.substring(0, 300));

      if (r.status === 429 || r.status === 413) {
        const waitMs = Math.min(3000 * Math.pow(2, attempt), 30000);
        console.log(`[GITHUB MODELS RATE-LIMIT] Esperando ${waitMs}ms antes de reintentar (intento ${attempt+1}/${retries+1})...`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        return { content: 'Uff, estoy muy ocupada. Espera un momento y vuelve a escribirme.' };
      }

      if (r.status === 401) {
        console.error('[GITHUB MODELS 401] Token inválido.');
        return { content: '⚠️ El token de GitHub no es válido. Sigue estos pasos:\n1. Ve a https://github.com/settings/tokens\n2. Clica "Generate new token" > "Classic token"\n3. Sin marcar nada, clica "Generate"\n4. Copia el token y pégalo en Ajustes > IA > GitHub Token' };
      }

      if (r.status === 400) {
        console.error('[GITHUB MODELS 400]', errText.substring(0, 300));
        if (attempt < retries) {
          const waitMs = Math.min(2000 * Math.pow(2, attempt), 20000);
          console.log(`[GITHUB MODELS 400] Reintentando en ${waitMs}ms (intento ${attempt+1}/${retries+1})...`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        return { content: 'Perdona, no entendí bien. ¿Puedes repetirlo de otra forma?' };
      }

      if (attempt < retries) {
        const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
        console.log(`[GITHUB MODELS ${r.status}] Reintentando en ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return { content: 'El servicio de IA está sobrecargado. Escríbeme de nuevo en unos segundos.' };
    } catch (e) {
      console.error('[GITHUB MODELS FETCH ERROR]', e.message);
      if (attempt < retries) {
        const waitMs = Math.min(2000 * Math.pow(2, attempt), 15000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return { content: 'Hay un problema de conexión. Escríbeme de nuevo en unos segundos.' };
    }
  }
}

async function searchService(query, data) {
  let q = query.toLowerCase().trim();
  const services = (data.services||[]).filter(s => !s._deleted);
  if (services.length === 0) return { error: 'No hay servicios disponibles.' };

  const STEM_MAP = {
    'cortar': 'corte', 'corto': 'corte', 'cort': 'corte',
    'peinar': 'peinado', 'peino': 'peinado',
    'lavar': 'lavado',
    'mechar': 'mechas',
    'depilar': 'depilacion', 'depilo': 'depilacion',
    'trenzar': 'trenzas',
    'alisar': 'alisado',
    'recoger': 'recogido',
    'maquillar': 'maquillaje',
    'colorar': 'color',
    'uñas': 'manicura', 'uña': 'manicura'
  };
  if (STEM_MAP[q]) q = STEM_MAP[q];

  const scoreService = (s) => {
    const name = s.name.toLowerCase().replace(/\.$/, '').trim();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(' ' + q)) return 2;
    if (name.includes(q)) return 3;
    const words = q.split(/\s+/).filter(w => w.length > 1);
    const matchAll = words.length > 0 && words.every(w => name.includes(w));
    if (matchAll) return 4;
    return 999;
  };

  const matches = services.map(s => ({ s, score: scoreService(s) })).filter(m => m.score < 999);
  if (matches.length === 0) return { error: 'No encontré servicios con ese nombre. Informa al cliente.' };

  matches.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const aName = a.s.name.toLowerCase();
    const bName = b.s.name.toLowerCase();
    const aHasCaballeros = aName.includes('caballeros') ? 1 : 0;
    const bHasCaballeros = bName.includes('caballeros') ? 1 : 0;
    if (aHasCaballeros !== bHasCaballeros) return aHasCaballeros - bHasCaballeros;
    const aLen = a.s.name.length;
    const bLen = b.s.name.length;
    if (aLen !== bLen) return aLen - bLen;
    return (a.s.price || 999) - (b.s.price || 999);
  });

  const best = matches[0];
  return [{
    id: best.s.id,
    name: best.s.name.replace(/\.$/, '').trim(),
    duration: best.s.duration,
    price: best.s.price
  }];
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
    case 'searchService': {
      return await searchService(args.query, data);
    }
    case 'checkAvailability': {
      return await checkAvailability(args.date, args.serviceId, data, args.extraServiceIds);
    }
    case 'bookAppointment': {
      return await bookAppointment(args, phone, data);
    }
    case 'getMyAppointments': {
      return await getClientAppointments(phone, data);
    }
    case 'cancelAppointment': {
      const ids = args.appointmentIds || (args.appointmentId ? [args.appointmentId] : []);
      if (ids.length === 0) return { error: 'Debes especificar al menos un ID de cita' };
      if (ids.length === 1) return await cancelAppointment(ids[0], phone, data);
      return await cancelMultipleAppointments(ids, phone, data);
    }
    case 'modifyAppointment': {
      return await modifyAppointment(args, phone, data);
    }
    default:
      return { error: `Unknown tool: ${fn.name}` };
  }
}

async function checkAvailability(date, serviceId, data, extraServiceIds) {
  if (!date) return { error: 'Debes especificar fecha' };

  const ids = extraServiceIds ? [serviceId, ...extraServiceIds] : (serviceId ? [serviceId] : []);
  if (ids.length === 0) return { error: 'Debes especificar al menos un servicio' };

  const settings = data.settings || {};
  const dayHours = getOpeningHoursForDay(date, settings);
  if (dayHours.closed) return { available: false, message: 'No hay disponibilidad para ese día (cerrado)' };

  const openMin = Math.round(dayHours.open * 60);
  const closeMin = Math.round(dayHours.close * 60);

  const emps = (data.employees||[]).filter(e => !e._deleted);
  if (!emps.length) return { available: false, message: 'No hay empleados disponibles' };

  const services = ids.map(id => (data.services||[]).find(s => s.id === id)).filter(Boolean);
  if (services.length !== ids.length) return { error: 'Los IDs de servicio no son válidos. Debes llamar a searchService() primero para obtener IDs válidos.' };

  const bloques = data.settings?.bloques || {};
  const gap = bloques.bloqueGap || 45;
  const bloque1Svcs = services.filter(s => s.bloque === 'bloque1');
  const bloque2Svcs = services.filter(s => s.bloque === 'bloque2');
  const otherSvcs = services.filter(s => s.bloque !== 'bloque1' && s.bloque !== 'bloque2');
  const bloque1Dur = bloque1Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
  const bloque2Dur = bloque2Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
  const otherDur = otherSvcs.reduce((sum, s) => sum + (s.duration || 30), 0);
  const hasBlocks = bloque1Svcs.length > 0 && bloque2Svcs.length > 0;
  const totalDur = otherDur + (hasBlocks ? bloque1Dur + gap + bloque2Dur : bloque1Dur + bloque2Dur);

  const slots = [];
  for (const emp of emps) {
    const appointments = (data.appointments||[]).filter(a =>
      !a._deleted && !a.cancelledBy && !a.pendingSalonConfirm && a.date === date && a.employeeId === emp.id
    );

    const breakStart = dayHours.breakStart !== null ? Math.round(dayHours.breakStart * 60) : null;
    const breakEnd = dayHours.breakEnd !== null ? Math.round(dayHours.breakEnd * 60) : null;

    const rangeOccupied = (rangeStart, rangeEnd) => appointments.some(a => {
      const aS = timeToMinutes(a.time);
      let aE;
      if (a.endTime) { aE = timeToMinutes(a.endTime); } else {
        const srv = (data.services||[]).find(s => s.id === a.serviceId);
        aE = aS + (srv ? (srv.duration || 30) : 30);
      }
      return rangeStart < aE && rangeEnd > aS;
    });

    let time = openMin;
    while (time + totalDur <= closeMin) {
      if (breakStart !== null && breakEnd !== null && time >= breakStart && time < breakEnd) {
        time = breakEnd;
        continue;
      }
      const tStr = minutesToTime(time);
      if (hasBlocks) {
        const b1End = time + bloque1Dur;
        const b2Start = b1End + gap;
        const b2End = b2Start + bloque2Dur;
        if (b2End > closeMin) { time += 15; continue; }
        const b1Occ = rangeOccupied(time, b1End);
        const b2Occ = rangeOccupied(b2Start, b2End);
        const conflict = b1Occ || b2Occ || (breakStart !== null && breakEnd !== null && (time < breakEnd && b1End > breakStart || b2Start < breakEnd && b2End > breakStart));
        if (!conflict) {
          const svcNames = services.map(s => s.name.replace(/\.$/, '').trim()).join(', ');
          slots.push({ time: tStr, employeeId: emp.id, employeeName: emp.name, serviceName: svcNames, hasBlocks: true, bloque1Dur, gap, bloque2Dur });
        }
      } else {
        const aEnd = time + totalDur;
        const conflict = rangeOccupied(time, aEnd);
        if (!conflict) {
          const svcNames = services.map(s => s.name.replace(/\.$/, '').trim()).join(', ');
          slots.push({ time: tStr, employeeId: emp.id, employeeName: emp.name, serviceName: svcNames });
        }
      }
      time += 15;
    }
  }

  if (slots.length === 0) return { available: false, message: 'No hay huecos disponibles para ese día' };

  // Ordenar TODOS los slots por hora globalmente (no por empleado) para que
  // el límite no discrimine a empleados o franjas horarias posteriores
  slots.sort((a, b) => a.time.localeCompare(b.time) || a.employeeName.localeCompare(b.employeeName));

  // Limitar para evitar payload enorme
  const limited = slots.slice(0, 200);
  const grouped = {};
  limited.forEach(s => {
    const key = s.time;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(s.employeeName);
  });

  const slotList = Object.entries(grouped).slice(0, 30).map(([t, emps]) => {
    const unique = [...new Set(emps)];
    return `${t} - ${unique.join(', ')}`;
  });

  const slotData = Object.entries(grouped).slice(0, 30).map(([t, _]) => {
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
  const { serviceIds, serviceId, date, time, employeeId } = args;
  const ids = serviceIds || (serviceId ? [serviceId] : []);
  if (ids.length === 0) return { error: 'Debes especificar al menos un servicio' };
  console.log(` [BOOK-DEBUG] phone="${phone}" clientName="${clientName}" serviceIds="${ids.join(',')}" date="${date}" time="${time}"`);

  const services = ids.map(id => (data.services||[]).find(s => s.id === id)).filter(Boolean);
  if (services.length !== ids.length) return { error: 'Los IDs de servicio no son válidos. Debes llamar a searchService() primero para obtener IDs válidos.' };

  const dur = services.reduce((sum, s) => sum + (s.duration || 30), 0);
  const reqStart = parseTime(time);
  const reqEnd = reqStart + dur / 60;

  const conflict = (data.appointments||[]).some(a =>
    !a._deleted && !a.cancelledBy && !a.pendingSalonConfirm && a.date === date && a.employeeId === employeeId && (() => {
      const as = (data.services||[]).find(s => s.id === a.serviceId);
      const aStart = parseTime(a.time);
      const aEnd = aStart + (as ? (as.duration || 30) : 30) / 60;
      return reqStart < aEnd && reqEnd > aStart;
    })()
  );

  if (conflict) return { error: 'Ese horario ya no está disponible. Prueba otra hora.' };

  const dayHours = getOpeningHoursForDay(date, data.settings);
  if (dayHours.breakStart !== null && dayHours.breakEnd !== null) {
    if (reqStart < dayHours.breakEnd && reqEnd > dayHours.breakStart) {
      return { error: 'Esa hora cae en el horario de descanso del mediodía. Por favor, elige otra hora.' };
    }
  }

  const normPhoneParam = normPhone(phone);
  console.log(` [BOOK-DEBUG] Buscando cliente por teléfono normPhone="${normPhoneParam}"`);
  let client = (data.clients||[]).find(c => normPhone(c.phone) === normPhoneParam && !c._deleted);
  console.log(` [BOOK-DEBUG] Cliente por teléfono: ${client ? client.name+' ('+client.phone+')' : 'NO ENCONTRADO'}`);

  if (!client && clientName && clientName.trim()) {
    const cleanName = clientName.trim().replace(/ \(Online\)$/i, '').toLowerCase();
    console.log(` [BOOK-DEBUG] Buscando cliente por nombre="${cleanName}"`);
    client = (data.clients||[]).find(c => {
      const cName = (c.name||'').replace(/ \(Online\)$/i, '').toLowerCase();
      return cName === cleanName && !c._deleted;
    });
    if (client) {
      console.log(` [BOOK-DEBUG] Cliente encontrado por nombre: ${client.name} (${client.phone}) -> actualizando teléfono a "${phone}"`);
      client.phone = phone;
      client._modified = Date.now();
    }
  }

  const isNewClient = !client;
  if (isNewClient) {
    console.log(` [BOOK-DEBUG] Creando NUEVO cliente: name="${clientName||'Cliente WhatsApp'}" phone="${phone}"`);
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
  } else if (clientName && clientName.trim() && client.name !== clientName.trim() && client.name !== 'Cliente WhatsApp') {
    console.log(` [BOOK-DEBUG] Actualizando nombre de cliente: "${client.name}" -> "${clientName.trim()}"`);
    client.name = clientName.trim();
    client._modified = Date.now();
  }

  const svcNames = services.map(s => s.name.replace(/\.$/, '').trim()).join(', ');
  const bloques = data.settings?.bloques || {};
  const gap = bloques.bloqueGap || 45;
  const bloque1Svcs = services.filter(s => s.bloque === 'bloque1');
  const bloque2Svcs = services.filter(s => s.bloque === 'bloque2');
  const otherSvcs = services.filter(s => s.bloque !== 'bloque1' && s.bloque !== 'bloque2');
  const hasBlocks = bloque1Svcs.length > 0 && bloque2Svcs.length > 0;

  const minutos = timeToMinutes(time);
  const mkAppt = (startMin, blockSvcs, blockNum, blockGroupId) => {
    const blockDur = blockSvcs.reduce((sum, s) => sum + (s.duration || 30), 0);
    const startStr = minutesToTime(startMin);
    const endStr = minutesToTime(startMin + blockDur);
    return {
      id: 'a'+Date.now().toString(36)+Math.random().toString(36).substr(2,4) + (blockNum ? '_b'+blockNum : ''),
      clientId: client.id,
      serviceId: blockSvcs[0]?.id || ids[0],
      serviceIds: blockSvcs.map(s => s.id),
      employeeId,
      date,
      time: startStr,
      endTime: endStr,
      source: 'whatsapp',
      status: 'pending',
      notes: 'Reserva por Whatsapp - ' + client.name + ' - ' + client.phone + ' - ' + blockSvcs.map(s => s.name.replace(/\.$/, '').trim()).join(', '),
      created: Date.now(),
      _modified: Date.now(),
      _deleted: false,
      pendingSalonConfirm: true,
      clientPhone: client.phone,
      blockGroupId,
      blockNum,
      apptBlocks: blockSvcs.map(s => ({ type: s.bloque || 'other', duration: s.duration || 30 }))
    };
  };

  let createdAppts = [];
  if (hasBlocks) {
    const blockGroupId = 'bg' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    const bloque1Start = minutos;
    const bloque1Duration = bloque1Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
    const bloque2Start = bloque1Start + bloque1Duration + gap;
    const bloque2Duration = bloque2Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);

    if (otherSvcs.length) {
      const otherDur = otherSvcs.reduce((sum, s) => sum + (s.duration || 30), 0);
      const otherEnd = bloque1Start + otherDur;
      let otherBlockNum = '1';
      let otherAppt = mkAppt(bloque1Start, otherSvcs, otherBlockNum, blockGroupId);
      createdAppts.push(otherAppt);
      data.appointments.push(otherAppt);
      // Ajustar inicio de bloque1 después de other
      const adjustedB1Start = otherEnd;
      const b1Appt = mkAppt(adjustedB1Start, bloque1Svcs, '1', blockGroupId);
      createdAppts.push(b1Appt);
      data.appointments.push(b1Appt);
      const adjustedB2Start = adjustedB1Start + bloque1Duration + gap;
      const b2Appt = mkAppt(adjustedB2Start, bloque2Svcs, '2', blockGroupId);
      createdAppts.push(b2Appt);
      data.appointments.push(b2Appt);
    } else {
      const b1Appt = mkAppt(bloque1Start, bloque1Svcs, '1', blockGroupId);
      createdAppts.push(b1Appt);
      data.appointments.push(b1Appt);
      const b2Appt = mkAppt(bloque2Start, bloque2Svcs, '2', blockGroupId);
      createdAppts.push(b2Appt);
      data.appointments.push(b2Appt);
    }

    const b1EndStr = minutesToTime(bloque1Start + bloque1Duration);
    const b2EndStr = minutesToTime(bloque2Start + bloque2Duration);
    try {
      await writeData(data);
      await forwardSync({ appointments: createdAppts, clients: [client] });
    } catch (e) {
      console.error('[BOOK-ERROR] Error al guardar cita:', e.message);
      data.appointments = data.appointments.filter(a => !createdAppts.includes(a));
      return { error: 'Hubo un problema al guardar tu cita. Inténtalo de nuevo.' };
    }

    return {
      success: true,
      message: `⏳ SOLICITUD ENVIADA (pendiente de confirmación):\n📅 ${formatDate(date)}\n🕐 1ª cita: ${time} - ${b1EndStr} (${bloque1Svcs.map(s => s.name.replace(/\.$/, '').trim()).join(', ')})\n🕐 2ª cita: ${minutesToTime(bloque2Start)} - ${b2EndStr} (${bloque2Svcs.map(s => s.name.replace(/\.$/, '').trim()).join(', ')})\n⏱️ Hueco entre servicios: ${gap} min\n👤 ${client.name}\n\nTe avisaremos cuando el salón confirme.`
    };
  } else {
    const appt = mkAppt(minutos, services, '', '');
    data.appointments.push(appt);
    try {
      await writeData(data);
      await forwardSync({ appointments: [appt], clients: [client] });
    } catch (e) {
      console.error('[BOOK-ERROR] Error al guardar cita:', e.message);
      data.appointments = data.appointments.filter(a => a !== appt);
      return { error: 'Hubo un problema al guardar tu cita. Inténtalo de nuevo.' };
    }

    const endMin = minutos + dur;
    const endTime = minutesToTime(endMin);

    return {
      success: true,
      message: `⏳ SOLICITUD ENVIADA (pendiente de confirmación del salón):\n📅 ${formatDate(date)}\n⏰ ${time} - ${endTime}\n💇 ${svcNames}\n👤 ${client.name}\n\nTe avisaremos por WhatsApp cuando el salón confirme tu cita.`
    };
  }
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

  const toCancel = appt.blockGroupId
    ? (data.appointments||[]).filter(a => !a._deleted && a.blockGroupId === appt.blockGroupId && a.clientId === appt.clientId)
    : [appt];

  toCancel.forEach(a => {
    a.pendingCancelWhatsApp = true;
    a.source = a.source || 'whatsapp';
    a._modified = Date.now();
  });

  try {
    await writeData(data);
    await forwardSync({ appointments: toCancel, clients: [] });
  } catch (e) {
    console.error('[CANCEL-ERROR] Error al guardar cancelación:', e.message);
    toCancel.forEach(a => { a.pendingCancelWhatsApp = false; a._modified = Date.now(); });
    return { error: 'Hubo un problema al cancelar. Inténtalo de nuevo.' };
  }

  return { success: true, message: '⏳ Tu solicitud de cancelación ha sido enviada. El salón la revisará y te confirmará.' };
}

async function cancelMultipleAppointments(appointmentIds, phone, data) {
  const results = [];
  let cancelled = 0;
  const clientPhones = [];
  for (const id of appointmentIds) {
    const appt = (data.appointments||[]).find(a => a.id === id && !a._deleted);
    if (!appt) { results.push({ id, error: 'No encontrada' }); continue; }
    const client = (data.clients||[]).find(c => c.id === appt.clientId);
    if (client && normPhone(client.phone) !== normPhone(phone)) {
      results.push({ id, error: 'No pertenece a este teléfono' }); continue;
    }
    const toCancel = appt.blockGroupId
      ? (data.appointments||[]).filter(a => !a._deleted && a.blockGroupId === appt.blockGroupId && a.clientId === appt.clientId)
      : [appt];
    toCancel.forEach(a => {
      a.pendingCancelWhatsApp = true;
      a.source = a.source || 'whatsapp';
      a._modified = Date.now();
    });
    if (!clientPhones.includes(client?.phone)) clientPhones.push(client?.phone);
    cancelled += toCancel.length;
  }
  if (cancelled === 0) return { error: 'No se pudo cancelar ninguna cita.' };
  await writeData(data);
  forwardSync({ appointments: data.appointments.filter(a => a.pendingCancelWhatsApp && a._modified > Date.now() - 5000), clients: [] });
  return { success: true, message: `⏳ Solicitud de cancelación enviada para ${cancelled} cita(s). El salón lo revisará y confirmará.` };
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
  appt.pendingSalonConfirm = true;
  appt.source = appt.source || 'whatsapp';
  appt.modificationCount = (appt.modificationCount || 0) + 1;
  appt._modified = Date.now();
  try {
    await writeData(data);
    await forwardSync({ appointments: [appt], clients: [] });
  } catch (e) {
    console.error('[MODIFY-ERROR] Error al guardar modificación:', e.message);
    appt.pendingDate = undefined;
    appt.pendingTime = undefined;
    appt.pendingEmployeeId = undefined;
    appt.clientModified = false;
    appt.pendingSalonConfirm = false;
    appt.modificationCount = (appt.modificationCount || 1) - 1;
    return { error: 'Hubo un problema al modificar. Inténtalo de nuevo.' };
  }

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
  const debugInfo = `[DEBUG] Buscando cliente con teléfono ${phone} (norm=${normPhone(phone)}). Clientes totales: ${(data.clients||[]).length}. Clientes coincidentes: ${clients.length}.`;
  if (!clients.length) return { appointments: [], message: `No tienes citas próximas. ${debugInfo} Fuente: ${data._source||'?'}.` };

  const clientIds = new Set(clients.map(c => c.id));
  const today = new Date().toISOString().split('T')[0];
  const allAppts = (data.appointments||[]).filter(a =>
    clientIds.has(a.clientId) && a.date >= today && !a._deleted && !a.cancelledBy
  ).sort((a,b) => (a.date+' '+a.time).localeCompare(b.date+' '+b.time));

  if (!allAppts.length) return { appointments: [], message: `No tienes citas próximas. ${debugInfo} Citas totales: ${(data.appointments||[]).length}. Fuente: ${data._source||'?'}.` };

  const empMap = {}; (data.employees||[]).forEach(e => empMap[e.id] = e.name);
  const svcMap = {}; (data.services||[]).forEach(s => svcMap[s.id] = s.name);

  const list = allAppts.map(a => {
    const svcNames = (a.serviceIds && a.serviceIds.length > 0 ? a.serviceIds : [a.serviceId]).map(id => svcMap[id]).filter(Boolean);
    const svcName = svcNames.length > 0 ? svcNames.join(', ') : 'Servicio';
    const empName = empMap[a.employeeId] || '';
    const pend = a.pendingSalonConfirm ? ' ⏳ Pendiente' : '';
    const canc = a.pendingCancelWhatsApp ? ' ⏳ Cancelación solicitada' : '';
    return `🔹 ${formatDate(a.date)} ${a.time}${a.endTime ? '-'+a.endTime : ''} - ${svcName}${empName ? ' con '+empName : ''}${pend}${canc}`;
  }).join('\n');

  return {
    appointments: allAppts.map(a => a.id),
    message: `Tus citas:\n${list}\n\nSi quieres cancelar o modificar alguna, dime cuál por su fecha y hora.`
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

async function httpGetJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function fetchData() {
  const syncUrls = [SYNC_URL.replace(/\/+$/, ''), 'https://nymaraestilistas.es/api'];
  for (const base of syncUrls) {
    try {
      const url = base + '/sync';
      const data = await httpGetJson(url, 5000);
      if ((data.services||[]).length > 0) {
        console.log(`[AI-DATA] Cloudflare: ${(data.services||[]).length} servicios, ${(data.appointments||[]).length} citas`);
        return data;
      }
    } catch (e) {
      console.log(`[AI-DATA] Cloudflare ${base} no disponible (${e.message})`);
    }
  }
  const localPorts = [3456, 3457, 3000];
  for (const port of localPorts) {
    try {
      const data = await httpGetJson(`http://localhost:${port}/sync`, 2000);
      if ((data.services||[]).length > 0) {
        console.log(`[AI-DATA] Fallback localhost:${port}: ${(data.services||[]).length} servicios, ${(data.appointments||[]).length} citas`);
        return data;
      }
    } catch (e) {}
  }
  const local = readData();
  console.log(`[AI-DATA] Fallback local: ${(local.services||[]).length} servicios, ${(local.appointments||[]).length} citas`);
  return local;
}

async function processWhatsAppMessage(phone, text) {
  try {
    console.log(` [AI-DEBUG] processWhatsAppMessage called with phone="${phone}"`);
    const data = await fetchData();

    // Auto-cleanup old pending confirmation appointments
    const pendingOld = (data.appointments||[]).filter(a => a.pendingSalonConfirm && isDatePast(a.date));
    if (pendingOld.length > 0) {
      console.log(`[AI-DATA] Limpiando ${pendingOld.length} citas pendientes viejas`);
      pendingOld.forEach(a => { a._deleted = true; a._modified = Date.now(); });
      try { await writeData(data); } catch (e) { console.log('[AI-DATA] Error al guardar limpieza:', e.message); }
    }

    console.log(` [AI-DEBUG] DATA: ${(data.services||[]).length} servicios, ${(data.employees||[]).length} empleados, ${(data.appointments||[]).length} citas`);
    const normPhoneParam = normPhone(phone);
    console.log(` [AI-DEBUG] normPhone="${normPhoneParam}"`);
    const clients = (data.clients||[]).filter(c => normPhone(c.phone) === normPhoneParam && !c._deleted);
    const clientInfo = clients.length > 0 ? clients[0] : null;
    console.log(` [AI-DEBUG] client found: ${clientInfo ? clientInfo.name + ' (' + clientInfo.phone + ')' : 'NONE'}`);

    const systemPrompt = buildSystemPrompt(data, clientInfo);
    const tools = buildTools();

    const { loadConversation, saveConversation } = require('./conversation');
    let history = await loadConversation(phone);
    history = history.filter((m, i, arr) => {
      if (m.role === 'assistant' && m.tool_calls) {
        const toolCallIds = new Set(m.tool_calls.map(tc => tc.id));
        const nextMsgs = arr.slice(i + 1);
        const allResponded = toolCallIds.size === 0 || [...toolCallIds].every(id => nextMsgs.some(n => n.role === 'tool' && n.tool_call_id === id));
        return allResponded;
      }
      return true;
    });
    if (history.length === 0) {
      const greeting = clientInfo
        ? `¡Hola ${clientInfo.name}! Soy Sara, la asistente virtual de ${BUSINESS_NAME}. ¿En qué puedo ayudarte? Puedo consultar disponibilidad, reservar citas, modificar o cancelar.`
        : `¡Hola! Soy Sara, la asistente virtual de ${BUSINESS_NAME}. ¿En qué puedo ayudarte? Puedo consultar disponibilidad, reservar citas, modificar o cancelar.`;
      history.push({ role: 'assistant', content: greeting });
    }

    history.push({ role: 'user', content: text });
    await saveConversation(phone, history);

    const apptKeywords = /\b(citas|mis citas|que citas|qué citas|reservas|mis reservas|agenda|recordar|pendientes|próximas)\b/i;
    if (apptKeywords.test(text)) {
      const filtered = history.filter(m => {
        if (m.role === 'tool' && m.content && (m.content.includes('Tus citas próximas') || m.content.includes('No tienes citas próximas') || m.content.includes('citas') || m.content.includes('appointments'))) return false;
        if (m.role === 'assistant' && m.content && (m.content.includes('Tus citas próximas') || m.content.includes('No tienes citas próximas') || m.content.includes('citas'))) return false;
        return true;
      });
      if (filtered.length !== history.length) {
        history = filtered;
        console.log('[AI-CLEAN] Historial de citas previo eliminado para forzar llamada fresca');
      }
    }

    const maxTurns = 3;
    for (let turn = 0; turn < maxTurns; turn++) {
      const ctx = [...safeHistorySlice(history, 8)];
      let result;

      result = await callGitHubModels(systemPrompt, ctx, tools);
 
      if (result.tool_calls) {
        history.push({ role: 'assistant', content: result.message?.content || null, tool_calls: result.tool_calls });
        const toolMessages = [];
 
        for (const tc of result.tool_calls) {
          const toolResult = await executeTool(tc, phone, data);
          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: truncateStr(JSON.stringify(toolResult), 2000)
          });
        }
        history.push(...toolMessages);
        await new Promise(r => setTimeout(r, 8000));
        let secondResult;
        const safeCtx2 = safeHistorySlice(history, 10);
        secondResult = await callGitHubModels(systemPrompt, safeCtx2, tools);
        if (secondResult.content && !secondResult.content.startsWith('Error') && !secondResult.content.startsWith('Lo siento')) {
          const clean = secondResult.content.trim() || 'Entendido. ¿Qué más necesitas?';
          history.push({ role: 'assistant', content: clean });
          await saveConversation(phone, history);
          return clean;
        }
        if (secondResult.tool_calls) {
          history.push({ role: 'assistant', content: null, tool_calls: secondResult.tool_calls });
          for (const tc of secondResult.tool_calls) {
            const toolResult = await executeTool(tc, phone, data);
            history.push({ role: 'tool', tool_call_id: tc.id, content: truncateStr(JSON.stringify(toolResult), 2000) });
          }
          continue;
        }
        history.push({ role: 'assistant', content: 'Perdona, no he entendido bien. ¿Puedes repetirlo?' });
        await saveConversation(phone, history);
        return 'Perdona, no he entendido bien. ¿Puedes repetirlo?';
      }

      if (result.content) {
        const errorPrefixes = ['Error', 'Lo siento, el asistente no está configurado', 'Lo siento, no hay IA configurada', 'Uff, estoy muy ocupada', 'Lo siento, hay un problema'];
        if (errorPrefixes.some(p => result.content.startsWith(p))) {
          console.error('[AI ERROR VISIBLE]', result.content);
          const reply = '⚠️ ' + result.content;
          history.push({ role: 'assistant', content: reply });
          await saveConversation(phone, history);
          return reply;
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
    const data = await fetchData();
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

    const apptKeywords = /\b(citas|mis citas|que citas|qué citas|reservas|mis reservas|agenda|recordar|pendientes|próximas)\b/i;
    if (apptKeywords.test(text)) {
      const filtered = history.filter(m => {
        if (m.role === 'tool' && m.content && (m.content.includes('Tus citas próximas') || m.content.includes('No tienes citas próximas') || m.content.includes('citas') || m.content.includes('appointments'))) return false;
        if (m.role === 'assistant' && m.content && (m.content.includes('Tus citas próximas') || m.content.includes('No tienes citas próximas') || m.content.includes('citas'))) return false;
        return true;
      });
      if (filtered.length !== history.length) {
        history = filtered;
        console.log('[AI-CLEAN] Historial de citas previo eliminado para forzar llamada fresca (phone)');
      }
    }

    const maxTurns = 2;
    for (let turn = 0; turn < maxTurns; turn++) {
      const ctx = safeHistorySlice(history, 8);
      let result;
      if (getGitHubToken()) {
        result = await callGitHubModels(systemPrompt, ctx, tools);
      } else {
        return '⚠️ No hay token de GitHub Models configurado. Contacta con el salón directamente.';
      }

      if (result.content) {
        const phoneErrorPrefixes = ['Error', 'Lo siento, el asistente no está configurado', 'Lo siento, no hay IA configurada', 'Uff, estoy muy ocupada', 'Lo siento, hay un problema', '⚠️ No hay API Key'];
        if (phoneErrorPrefixes.some(p => result.content.startsWith(p))) {
          console.error('[PHONE AI ERROR VISIBLE]', result.content);
          history.push({ role: 'assistant', content: result.content });
          await saveConversation(phone + ':phone', history);
          return result.content;
        }
        const inlineFns = [...result.content.matchAll(FUNCTION_CALL_RE)];
        if (inlineFns.length > 0) {
          for (const [, fnName, argsStr] of inlineFns) {
            const toolResult = await executeTool({ function: { name: fnName, arguments: argsStr } }, phone, data);
            history.push({ role: 'tool', tool_call_id: fnName + '_' + Date.now(), content: truncateStr(JSON.stringify(toolResult), 2000) });
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
          toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: truncateStr(JSON.stringify(toolResult), 2000) });
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

async function forwardSync(payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (SYNC_KEY) headers['Authorization'] = 'Bearer ' + SYNC_KEY;
  const url = SYNC_URL.replace(/\/+$/, '') + '/sync';
  console.log('[FORWARD] Enviando a Cloudflare:', JSON.stringify({
    appointments: (payload.appointments||[]).map(a => ({ id: a.id, clientPhone: a.clientPhone, date: a.date, time: a.time })),
    clients: (payload.clients||[]).map(c => ({ id: c.id, name: c.name, phone: c.phone }))
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const errText = await res.text();
    console.warn('[FORWARD] Cloudflare returned', res.status, errText.substring(0, 200));
    if (res.status >= 500) throw new Error('Cloudflare error ' + res.status);
  } else {
    console.log('[FORWARD] Cita enviada a Cloudflare OK');
  }
}

module.exports = {
  processWhatsAppMessage,
  processPhoneMessage,
  processAudioMessage,
  buildSystemPrompt,
  buildTools,
  executeTool,
  checkAvailability,
  bookAppointment,
  cancelAppointment,
  modifyAppointment,
  getClientAppointments,
  getBusinessInfo,
  normPhone
};
