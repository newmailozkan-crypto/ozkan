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
  if (!r || (!r.orders.length && !r.comments.length && !r.satisfaction.length && !giftActive(userId))) return '';
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
  if (giftActive(userId)) lines.push("Bu müşteriye hediye teklifi yapıldı: sipariş verirse siparişine 249 TL değerinde 3'lü Nike çorap HEDİYE eklenecek. Müşteri sipariş vermek isterse bunu özette belirt; ayrıca fiyat/kampanya sunma.");
  return lines.join('\n');
}

export const persist = save;

// ---------- konuşma durumu (hatırlatma ve insan devri için kalıcı) ----------
export const all = () => db;

const convo = (userId) => {
  const r = rec(userId);
  r.convo = r.convo || {};
  return r.convo;
};

export function touchUser(userId) {
  const c = convo(userId);
  c.lastUserAt = Date.now();
  c.followupStage = 0;
  save();
}
export function touchBot(userId) {
  convo(userId).lastBotAt = Date.now();
  save();
}
export function markFollowupStage(userId, stage) {
  convo(userId).followupStage = stage;
  save();
}
// Hediye çorap teklifi yapıldı (24 saat geçerli): sipariş gelirse siparişe hediye eklenir
export function markGift(userId) {
  convo(userId).giftAt = Date.now();
  save();
}
export function giftActive(userId) {
  const at = get(userId)?.convo?.giftAt;
  return Boolean(at && Date.now() - at < 24 * 3600 * 1000);
}
// Mağaza yetkilisi (insan) müşteriyle yazıştığında bot belirli süre susar ve sadece izler
export function markHuman(userId) {
  convo(userId).humanAt = Date.now();
  save();
}
export function humanActive(userId, hours) {
  const at = get(userId)?.convo?.humanAt;
  return Boolean(at && hours > 0 && Date.now() - at < hours * 3600 * 1000);
}

// Son konuşma satırları (bot yeniden başlasa da hatırlatma mesajı bağlama uygun yazılabilsin)
export function pushRecent(userId, role, text) {
  const t = String(text || '').trim().slice(0, 300);
  if (!t) return;
  const r = rec(userId);
  r.recent = r.recent || [];
  r.recent.push({ r: role, t });
  if (r.recent.length > 8) r.recent.shift();
  save();
}
export const recent = (userId) => get(userId)?.recent || [];

// ---------- ekibin gerçek cevaplarından öğrenme ----------
let learned = [];
try {
  learned = JSON.parse(fs.readFileSync(cfg.learnedFile, 'utf8'));
} catch {
  /* dosya yok */
}
let learnTimer = null;
const scrub = (t) => String(t || '').replace(/\d[\d\s().-]{6,}\d/g, '…').slice(0, 300); // telefon/numara benzeri dizileri sil

export function addLearned(q, a) {
  const Q = scrub(q);
  const A = scrub(a);
  if (!Q || !A || A.length < 8) return;
  learned.push({ q: Q, a: A, ts: Date.now() });
  if (learned.length > 60) learned.shift();
  clearTimeout(learnTimer);
  learnTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(cfg.learnedFile), { recursive: true });
      fs.writeFileSync(cfg.learnedFile, JSON.stringify(learned));
    } catch (e) {
      console.error('[learned] yazılamadı:', e.message);
    }
  }, 500);
  learnTimer.unref?.();
}

export function learnedText(n = 8) {
  if (!learned.length) return '';
  const rows = learned.slice(-n).map((x) => `- Müşteri: "${x.q.slice(0, 120)}" → Ekibimiz: "${x.a.slice(0, 160)}"`);
  return `## EKİBİMİZİN GERÇEK MÜŞTERİ CEVAPLARI (üslup/yaklaşım örneği)\nAşağıdakiler ekibimizin müşterilerle yazışmalarından alınmış örneklerdir. Tonu ve yaklaşımı öğren; ancak MAĞAZA KURALLARI ile çelişen bir bilgi/fiyat/kampanya görürsen MAĞAZA KURALLARI geçerlidir. Kişiye özel bilgileri başkasına söyleme.\n${rows.join('\n')}`;
}
