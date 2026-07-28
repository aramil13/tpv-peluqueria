const { processPhoneMessage } = require('../lib/ai-assistant');

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Nymara Estilistas';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';

function escXml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// Deployed
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');

  try {
    let raw = '';
    if (req.method === 'POST') {
      for await (const chunk of req) raw += chunk;
    }
    const params = new URLSearchParams(raw);
    const speechResult = params.get('SpeechResult') || '';
    const caller = params.get('From') || '';
    console.log(`[VOICE IN] ${caller}: ${speechResult}`);

    let responseText = '';

    if (!speechResult) {
      // Si es el inicio de la llamada o no se detectó voz
      responseText = `Hola, bienvenido a ${BUSINESS_NAME}. Soy Sara, tu asistente virtual. ¿En qué puedo ayudarte? Puedes pedir cita, consultar disponibilidad o preguntar por nuestros servicios.`;
    } else {
      // Procesar el mensaje con la IA
      responseText = await processPhoneMessage(caller, speechResult);
    }

    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="https://nymaraestilistas.es/api/phone-webhook" method="POST" language="es-ES" speechTimeout="auto">
    <Say voice="woman" language="es-ES">${escXml(responseText)}</Say>
  </Gather>
  <Say voice="woman" language="es-ES">Si no tienes más dudas, gracias por llamar a ${BUSINESS_NAME}. ¡Que tengas un buen día!</Say>
</Response>`);

  } catch (e) {
    console.error('[PHONE WEBHOOK ERROR]', e.message);
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="woman" language="es-ES">Lo siento, ha surgido un problema técnico con la centralita. Por favor, llámanos directamente al ${BUSINESS_PHONE}.</Say>
</Response>`);
  }
};
