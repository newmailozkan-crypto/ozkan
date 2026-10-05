import { cfg } from './config.js';
import { redact } from './util.js';

export async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.tgChatId, text: redact(text), disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram hata: ${data.description || res.status}`);
  return data;
}

const tl = (n) => `${Number(n).toLocaleString('tr-TR')} TL`;

export function formatOrder(o) {
  const lines = o.items.map((i) => `• ${i.title} | Beden: ${i.size || '-'} | ${i.qty} adet | ${tl(i.lineTotal)}`);
  return [
    '🛍 YENİ SİPARİŞ' + (o.id ? ` (No: ${o.id})` : ''),
    '',
    `İsim Soyisim: ${o.name}`,
    `Telefon: ${o.phone}`,
    `Açık Adres: ${o.address}`,
    `İl / İlçe: ${o.city} / ${o.district}`,
    '',
    'İstediği Ürünler:',
    ...lines,
    '',
    `Ara Toplam: ${tl(o.subtotal)}`,
    o.discount ? `İndirim${o.campaignNote ? ` (${o.campaignNote})` : ''}: -${tl(o.discount)}` : null,
    o.shipping ? `Kargo ücreti: +${tl(o.shipping)}` : 'Kargo: ücretsiz',
    o.gift ? "🎁 HEDİYE: 249 ₺ değerinde 3'lü Nike çorap (hatırlatma teklifi) siparişe eklenecek" : null,
    `NİHAİ SATIŞ FİYATI (kapıda ödeme): ${tl(o.total)}`,
    '',
    `Instagram: ${o.igUsername ? '@' + o.igUsername : o.igUserId}`,
    '🏷 Durum: SİPARİŞ VERDİ',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

export async function notifyHuman(reason, igUserId, igUsername, lastMessage) {
  return sendTelegram(
    [`⚠️ İNSAN DESTEĞİ GEREKİYOR`, `Sebep: ${reason}`, `Instagram: ${igUsername ? '@' + igUsername : igUserId}`, lastMessage ? `Son mesaj: ${lastMessage}` : '']
      .filter(Boolean)
      .join('\n')
  );
}

export function formatCancel(o, igUsername, igUserId) {
  return [
    `❌ SİPARİŞ İPTAL EDİLDİ (No: ${o.id})`,
    'Müşteri siparişi verdikten kısa süre sonra DM üzerinden iptal etti; bot iptali onayladı. Lütfen bu siparişi HAZIRLAMAYIN / kargolamayın.',
    '',
    `İsim Soyisim: ${o.name}`,
    `Telefon: ${o.phone}`,
    `İl / İlçe: ${o.city} / ${o.district}`,
    'Ürünler: ' + o.items.map((i) => `${i.title} (${i.size})`).join('; '),
    `Tutar: ${tl(o.total)}`,
    `Instagram: ${igUsername ? '@' + igUsername : igUserId}`,
  ].join('\n');
}

export async function sendTelegramPhoto(buffer, mediaType, caption) {
  const form = new FormData();
  form.append('chat_id', String(cfg.tgChatId));
  form.append('caption', redact(caption || '').slice(0, 1000));
  form.append('photo', new Blob([buffer], { type: mediaType || 'image/jpeg' }), 'memnuniyet.jpg');
  const res = await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendPhoto`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram fotoğraf hatası: ${data.description || res.status}`);
  return data;
}
