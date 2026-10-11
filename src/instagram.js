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
    signal: AbortSignal.timeout(30000), // takılan istek sırayı kilitlemesin
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
// Botun kendi gönderdiği mesajları (yankı/echo olaylarında) insan mesajından ayırmak için son gönderilenleri tutar
const sentLog = [];
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
// Instagram yankıda biçimi değiştirebilir (kalın **, emoji, satır sonu): yalnızca harf/rakamlara bakarak karşılaştır
const loose = (t) => String(t || '').toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 60);
function noteSent(recipientId, text, mid) {
  sentLog.push({ to: String(recipientId), text: norm(text), mid, at: Date.now() });
  if (sentLog.length > 300) sentLog.shift();
}
export function isOurMessage(recipientId, mid, text, hasAttachment) {
  const now = Date.now();
  const nt = norm(text);
  return sentLog.some((e) => {
    if (now - e.at > 10 * 60 * 1000) return false;
    if (mid && e.mid === mid) return true;
    if (e.to !== '*' && e.to !== String(recipientId)) return false;
    if (nt) {
      if (e.text && (e.text === nt || e.text.startsWith(nt) || nt.startsWith(e.text))) return true;
      const a = loose(e.text), b = loose(nt);
      const n = Math.min(a.length, b.length, 25);
      return n >= 8 && a.slice(0, n) === b.slice(0, n); // biçim farkı olsa da aynı mesaj
    }
    return hasAttachment && now - e.at < 3 * 60 * 1000; // görsel yankısı: son 3 dk içinde bu müşteriye bot bir şey gönderdiyse botun fotoğrafıdır
  });
}

export async function sendText(recipientId, text) {
  const ids = [];
  for (const part of chunkText(text)) {
    const r = await call('/me/messages', { recipient: { id: recipientId }, message: { text: part } });
    noteSent(recipientId, part, r?.message_id);
    if (r?.message_id) ids.push(r.message_id);
  }
  return ids;
}

export async function sendImage(recipientId, url) {
  const r = await call('/me/messages', {
    recipient: { id: recipientId },
    message: { attachment: { type: 'image', payload: { url } } },
  });
  noteSent(recipientId, '', r?.message_id);
  return r;
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
  const part = chunkText(text)[0];
  const r = await call('/me/messages', {
    recipient: { comment_id: commentId },
    message: { text: part },
  });
  noteSent('*', part, r?.message_id); // alıcı kimliği bilinmiyor: yankıyı botun mesajı say
  return r;
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

// Müşteriyle son yazışmalar (bot yeniden başlamış veya insan yazışmış olsa bile sohbet geçmişini okuyabilmek için)
export async function fetchHistory(userId, limit = 20) {
  try {
    const r = await call(`/me/conversations?platform=instagram&user_id=${encodeURIComponent(userId)}&fields=messages.limit(${limit}){id,message,from,created_time,attachments}`, null, 'GET');
    const msgs = r?.data?.[0]?.messages?.data || [];
    return msgs
      .map((m) => ({
        mid: m.id,
        role: String(m.from?.id) === String(cfg.igAccountId) ? 'assistant' : 'user',
        text: String(m.message || '').trim() || (m.attachments?.data?.length ? '[görsel/paylaşım gönderildi]' : ''),
        at: Date.parse(m.created_time) || 0,
      }))
      .filter((m) => m.text)
      .sort((a, b) => a.at - b.at);
  } catch (e) {
    console.error('[history] okunamadı:', e.message);
    return [];
  }
}
