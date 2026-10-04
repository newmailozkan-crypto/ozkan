import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

// Müşteri hafızası: siparişler, yorumlar, memnuniyet fotoğrafı. Dosyaya yazılır; yeniden başlatmada geri yüklenir.
// (Render Free'de disk geçicidir: yeni dağıtımda silinebilir. Kalıcı disk bağlanırsa CUSTOMERS_FILE ile oraya yazılır.)
const db = new Map(); // userId -> {username, orders:[], comments:[], satisfaction:[]}
let timer = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.customersFile, 'utf8'));
    for (const [k, v] of Object.entries(raw)) db.set(k, v);
    console.log(`[customers] ${db.size} müşteri kaydı yüklendi`);
  } catch {
    /* dosya yok: boş başla */
  }
}
load();

function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(cfg.customersFile), { recursive: true });
      fs.writeFileSync(cfg.customersFile, JSON.stringify(Object.fromEntries(db)));
    } catch (e) {
      console.error('[customers] yazılamadı:', e.message);
    }
  }, 500);
  timer.unref?.();
}

const rec = (userId) => {
  const k = String(userId);
  if (!db.has(k)) db.set(k, { username: null, orders: [], comments: [], satisfaction: [] });
  return db.get(k);
};

export const get = (userId) => db.get(String(userId)) || null;

export function setUsername(userId, username) {
  if (!username) return;
  rec(userId).username = username;
  save();
}

export const newOrderId = () => 'S' + Date.now().toString(36).toUpperCase().slice(-4) + Math.random().toString(36).toUpperCase().slice(2, 4);

export function addOrder(userId, order) {
  const r = rec(userId);
  const o = { ...order, id: order.id || newOrderId(), ts: Date.now(), status: 'aktif' };
  r.orders.push(o);
  save();
  return o;
}

// İptal: son aktif sipariş (veya verilen no). Penceredeyse iptal eder.
export function cancelOrder(userId, orderId) {
  const r = get(userId);
  const active = (r?.orders || []).filter((o) => o.status === 'aktif');
  const o = orderId ? active.find((x) => x.id === orderId) : active[active.length - 1];
  if (!o) return { durum: 'siparis_yok' };
  const ageH = (Date.now() - o.ts) / 3600000;
  if (ageH > cfg.cancelWindowHours) return { durum: 'sure_gecti', order: o, saat: Math.round(ageH * 10) / 10 };
  o.status = 'iptal';
  o.cancelledAt = Date.now();
  save();
  return { durum: 'iptal_edildi', order: o };
}

export function addComment(userId, c) {
  const r = rec(userId);
  r.comments.push({ ...c, ts: Date.now() });
  r.comments = r.comments.slice(-10);
  save();
}

export function addSatisfaction(userId) {
  const r = rec(userId);
  r.satisfaction.push(Date.now());
  save();
}

const tl = (n) => `${Number(n).toLocaleString('tr-TR')} TL`;
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 90 ? `${m} dk önce` : `${Math.round(m / 6) / 10} saat önce`;
};

// Sistem istemine eklenen müşteri özeti
export function contextText(userId) {
  const r = get(userId);
  if (!r || (!r.orders.length && !r.comments.length && !r.satisfaction.length)) return '';
  const lines = ['## BU MÜŞTERİ HAKKINDA BİLDİKLERİMİZ (hafıza)'];
  if (r.orders.length) {
    lines.push(`Müşteri SİPARİŞ VERDİ olarak işaretli. Siparişleri:`);
    for (const o of r.orders) {
      const items = o.items.map((i) => `${i.title} (${i.size} no${i.qty > 1 ? ', ' + i.qty + ' adet' : ''})`).join('; ');
      lines.push(`- No ${o.id} | ${ago(o.ts)} | ${o.status.toUpperCase()} | ${items} | ödenecek ${tl(o.total)}${o.shipping ? ' (kargo dahil)' : ''} | ${o.city}/${o.district}`);
    }
    lines.push('Müşteri sipariş hakkında soru sorarsa bu bilgilere göre cevap ver; sipariş zaten alındı, tekrar sipariş bilgisi isteme.');
  }
  if (r.comments.length) {
    lines.push('Müşterinin gönderi altı yorumları ve verdiğimiz cevaplar:');
    for (const c of r.comments) lines.push(`- Yorum: "${c.text}" | Herkese açık cevabımız: "${c.publicReply || '-'}" | DM'de yazdığımız: "${c.dm || '-'}"`);
  }
  if (r.satisfaction.length) lines.push('Müşteri memnuniyet fotoğrafı gönderdi (teşekkür edildi).');
  return lines.join('\n');
}

export const persist = save;
