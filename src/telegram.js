import { cfg } from './config.js';

export async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.tgChatId, text, disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram hata: ${data.description || res.status}`);
  return data;
}

const tl = (n) => `${Number(n).toLocaleString('tr-TR')} TL`;

export function formatOrder(o) {
  const lines = o.items.map((i) => `• ${i.title} | Beden: ${i.size || '-'} | ${i.qty} adet | ${tl(i.lineTotal)}`);
  return [
    '🛍 YENİ SİPARİŞ',
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
    `NİHAİ SATIŞ FİYATI: ${tl(o.total)}`,
    '',
    `Instagram: ${o.igUsername ? '@' + o.igUsername : o.igUserId}`,
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
