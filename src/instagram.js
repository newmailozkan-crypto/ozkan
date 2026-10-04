import crypto from 'node:crypto';
import { cfg } from './config.js';

const base = () => `https://graph.instagram.com/${cfg.graphVersion}`;

async function call(path, body, method = 'POST') {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.igToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    throw new Error(`Instagram API ${res.status}: ${msg}`);
  }
  return data;
}

export function verifySignature(rawBody, header) {
  if (!cfg.appSecret) return true; // secret yoksa doğrulama atlanır (uyarı config'de)
  if (!header || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', cfg.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Instagram DM metin sınırı ~1000 karakter: cümle sınırlarından böl
function chunkText(text, max = 900) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('\n', max), rest.lastIndexOf('. ', max), rest.lastIndexOf(' ', max));
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export async function sendText(recipientId, text) {
  for (const part of chunkText(text)) {
    await call('/me/messages', { recipient: { id: recipientId }, message: { text: part } });
  }
}

export async function sendImage(recipientId, url) {
  return call('/me/messages', {
    recipient: { id: recipientId },
    message: { attachment: { type: 'image', payload: { url } } },
  });
}

export async function typingOn(recipientId) {
  try {
    await call('/me/messages', { recipient: { id: recipientId }, sender_action: 'typing_on' });
  } catch {
    /* önemsiz */
  }
}

// Gönderi altındaki yoruma herkese açık yanıt
export async function replyToComment(commentId, text) {
  return call(`/${commentId}/replies`, { message: text });
}

// Yorum sahibine DM (özel yanıt): yorum başına 1 kez, 7 gün içinde
export async function privateReply(commentId, text) {
  return call('/me/messages', {
    recipient: { comment_id: commentId },
    message: { text: chunkText(text)[0] },
  });
}

export async function getProfile(igsid) {
  try {
    return await call(`/${igsid}?fields=name,username`, null, 'GET');
  } catch {
    return {};
  }
}

// Yorum yapılan gönderinin açıklaması (hangi ürün olduğunu anlamak için)
export async function getMedia(mediaId) {
  try {
    return await call(`/${mediaId}?fields=caption,permalink`, null, 'GET');
  } catch {
    return {};
  }
}
