const { readData } = require('../lib/kv-data');
const { processPhoneMessage } = require('../lib/ai-assistant');

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Nymara Estilistas';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';

function escXml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function twiml(text) {
  const safe = escXml(text);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/phone-process" method="POST" language="es-ES" speechTimeout="auto" speechModel="default">
    <Say voice="alice" language="es-ES">${safe}</Say>
  </Gather>
  <Say voice="alice" language="es-ES">No logro entenderte. Llámanos al ${BUSINESS_PHONE}. Gracias y adiós.</Say>
</Response>`;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method !== 'POST') {
    res.status(200).send(twiml(`Hola, soy Sara de ${BUSINESS_NAME}. Dime cómo puedo ayudarte.`));
    return;
  }

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);

    const caller = params.get('From') || '';
    const speechResult = params.get('SpeechResult') || '';
    const callSid = params.get('CallSid') || '';

    console.log('[PHONE]', callSid, caller, speechResult);

    if (!speechResult) {
      res.status(200).send(twiml(`Hola, soy Sara de ${BUSINESS_NAME}. ¿En qué puedo ayudarte? Puedes pedir cita, consultar disponibilidad o preguntar por servicios.`));
      return;
    }

    const responseText = await processPhoneMessage(caller, speechResult);
    res.status(200).send(twiml(escXml(responseText)));

  } catch (e) {
    console.error('[PHONE WEBHOOK ERROR]', e.message);
    res.status(200).send(twiml(`Lo siento, hay un problema técnico. Llámanos al ${BUSINESS_PHONE}. Adiós.`));
  }
};
