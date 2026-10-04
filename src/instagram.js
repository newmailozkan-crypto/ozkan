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

// Gönderilen mesajların kimliklerini döndürür (müşteri "yanıtla" yaptığında hangi mesaja yanıt verdiğini bilmek için)
export async function sendText(recipientId, text) {
  const ids = [];
  for (const part of chunkText(text)) {
    const r = await call('/me/messages', { recipient: { id: recipientId }, message: { text: part } });
    if (r?.message_id) ids.push(r.message_id);
  }
  return ids;
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
    return await call(`/${mediaId}?fields=caption,permalink,media_type,media_url,thumbnail_url`, null, 'GET');
  } catch {
    return {};
  }
}

// Kendi gönderi/hikayelerimizin listesi (müşteri bunları DM'den iletince hangi ürün olduğunu bulmak için), 10 dk önbellekli
let mediaCache = { at: 0, items: [] };
export async function listOwnMedia() {
  if (Date.now() - mediaCache.at < 10 * 60 * 1000 && mediaCache.items.length) return mediaCache.items;
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink';
  const items = [];
  for (const edge of ['media', 'stories']) {
    try {
      let path = `/me/${edge}?fields=${fields}&limit=50`;
      for (let i = 0; i < 3 && path; i++) {
        const r = await call(path, null, 'GET');
        items.push(...(r.data || []));
        const next = r.paging?.next;
        path = next ? next.replace(/^https?:\/\/[^/]+\/[^/]+/, '') : null;
      }
    } catch (e) {
      console.error(`[media] /me/${edge} okunamadı:`, e.message);
    }
  }
  if (items.length) mediaCache = { at: Date.now(), items };
  return items;
}
