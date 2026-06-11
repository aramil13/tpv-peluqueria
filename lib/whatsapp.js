const env = globalThis.__ENV || process.env;
const TWILIO_ACCOUNT_SID = env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = env.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP_NUMBER = env.TWILIO_WHATSAPP_NUMBER || '';

function getAuth() {
  return Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64');
}

async function sendMessage(to, text) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return { error: 'Twilio not configured' };
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${getAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`, To: `whatsapp:${to}`, Body: text })
    });
    return r.json();
  } catch (e) {
    console.error('[TWILIO SEND ERROR]', e.message);
    return { error: e.message };
  }
}

async function sendButtons(to, text, buttons) {
  const opts = buttons.map((b, i) => `${i+1}. ${b}`).join('\n');
  return sendMessage(to, text + '\n\n' + opts);
}

async function downloadMedia(mediaUrl) {
  if (!mediaUrl || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  try {
    const buf = await (await fetch(mediaUrl, { headers: { Authorization: `Basic ${getAuth()}` } })).arrayBuffer();
    return { buffer: Buffer.from(buf), mimeType: '' };
  } catch { return null; }
}

function markAsRead() {}

module.exports = { sendMessage, sendButtons, downloadMedia, markAsRead };
