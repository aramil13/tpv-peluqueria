const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const API_BASE = 'https://graph.facebook.com/v21.0';

async function sendMessage(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) return { error: 'WhatsApp not configured' };
  const r = await fetch(`${API_BASE}/${WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
  return r.json();
}

async function sendButtons(to, text, buttons) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) return { error: 'WhatsApp not configured' };
  const r = await fetch(`${API_BASE}/${WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button', body: { text },
        action: { buttons: buttons.map((b, i) => ({ type: 'reply', reply: { id: `btn_${i}`, title: b } })) }
      }
    })
  });
  return r.json();
}

async function downloadMedia(mediaId) {
  if (!mediaId || !WHATSAPP_TOKEN) return null;
  try {
    const info = await (await fetch(`${API_BASE}/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } })).json();
    if (!info.url) return null;
    const buf = await (await fetch(info.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } })).arrayBuffer();
    return { buffer: Buffer.from(buf), mimeType: info.mime_type };
  } catch { return null; }
}

function markAsRead(messageId) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID || !messageId) return;
  fetch(`${API_BASE}/${WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId })
  }).catch(() => {});
}

module.exports = { sendMessage, sendButtons, downloadMedia, markAsRead };
