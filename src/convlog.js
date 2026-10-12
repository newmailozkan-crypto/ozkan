import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

// Kalıcı sohbet kaydı: SON 30 müşterinin sohbeti diskte tutulur (kim, ne konuştu).
// Her müşteri için son 30 mesaj tam, daha eskileri kısa satırlar (older) olarak saklanır.
// Kayıtta olmayan (30'dan eski) bir müşteri yazarsa sohbet Instagram'dan EN BAŞTAN okunup yeniden kurulur (Claude ücreti yok).
export const MAX_CUSTOMERS = 30;
export const MAX_MSGS = 30;
const MAX_OLDER = 60;

const db = new Map(); // id -> {name, at, fullAt, older:[], msgs:[{r,t,at,m}]}
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cfg.convFile, 'utf8')))) db.set(k, v);
  console.log(`[sohbet] ${db.size} müşterinin sohbet kaydı diskten yüklendi`);
} catch {
  /* dosya yok */
}

let t = null;
function save() {
  clearTimeout(t);
  t = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(cfg.convFile), { recursive: true });
      fs.writeFileSync(cfg.convFile, JSON.stringify(Object.fromEntries(db)));
    } catch (e) {
      console.error('[sohbet] yazılamadı:', e.message);
    }
  }, 1500);
  t.unref?.();
}

function evict() {
  if (db.size <= MAX_CUSTOMERS) return;
  const sorted = [...db.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  for (const [k] of sorted.slice(MAX_CUSTOMERS)) db.delete(k);
}

const oneLine = (r, tx, at) => `${stamp(at)} ${r === 'u' ? 'Müşteri' : r === 'h' ? 'Yetkili (insan)' : 'Biz'}: ${tx}`;
const stamp = (at) =>
  at ? new Date(at).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

export const has = (id) => db.has(String(id));
export const get = (id) => db.get(String(id)) || null;
export const fullAt = (id) => db.get(String(id))?.fullAt || 0;
export const count = () => db.size;

function entry(id) {
  const k = String(id);
  let e = db.get(k);
  if (!e) {
    e = { name: null, at: Date.now(), fullAt: 0, older: [], msgs: [] };
    db.set(k, e);
    evict();
  }
  return e;
}

export function setName(id, name) {
  if (!name) return;
  entry(id).name = name;
  save();
}

// role: 'u' müşteri, 'a' bot, 'h' insan yetkili
export function add(id, role, text, media = false, at = Date.now()) {
  const tx = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!tx && !media) return;
  const e = entry(id);
  const last = e.msgs[e.msgs.length - 1];
  if (last && last.r === role && last.t === tx && Math.abs((at || 0) - (last.at || 0)) < 5000) return; // çift kayıt
  e.msgs.push({ r: role, t: tx, at, m: media ? 1 : 0 });
  e.at = Date.now();
  while (e.msgs.length > MAX_MSGS) {
    const old = e.msgs.shift();
    e.older.push(oneLine(old.r, old.m && !old.t ? '(görsel/paylaşım)' : old.t.slice(0, 110), old.at));
  }
  while (e.older.length > MAX_OLDER) e.older.shift();
  save();
}

// Instagram'dan okunan TÜM sohbetle kaydı yeniden kurar (en eski -> en yeni)
export function seed(id, history) {
  const e = entry(id);
  const rows = (history || []).map((h) => ({
    r: h.role === 'assistant' ? (/\[Mağaza yetkilisi/.test(h.text || '') ? 'h' : 'a') : 'u',
    t: String(h.text || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    at: h.at || 0,
    m: h.media ? 1 : 0,
  })).filter((x) => x.t || x.m);
  if (!rows.length) return;
  e.msgs = rows.slice(-MAX_MSGS);
  e.older = rows.slice(0, -MAX_MSGS).map((x) => oneLine(x.r, x.m && !x.t ? '(görsel/paylaşım)' : x.t.slice(0, 110), x.at)).slice(-MAX_OLDER);
  e.fullAt = Date.now();
  e.at = Math.max(e.at || 0, rows[rows.length - 1].at || 0, Date.now() - 1000);
  save();
}

// Bota verilecek hafıza bloğu
export function memoText(id) {
  const e = get(id);
  if (!e || (!e.msgs.length && !e.older.length)) return '';
  const sizes = [];
  const shown = [];
  const asked = [];
  for (const m of e.msgs) {
    if (m.r === 'u') {
      const sz = m.t.match(/(?:^|[^\d])(3[5-9]|4[0-9])(?:[.,]5)?(?!\d)/);
      if (sz && /numara|no\b|giyiyorum|istiyorum|var mı|beden|\b\d{2}\b/i.test(m.t)) sizes.push(sz[0].replace(/^\D/, ''));
      if (/\?|var mı|fiyat|kaç|renk|stok/i.test(m.t)) asked.push(m.t.slice(0, 90));
    } else {
      const mm = m.t.match(/^(.{3,70}?) — [\d.]+ TL$/);
      if (mm && !shown.includes(mm[1])) shown.push(mm[1]);
    }
  }
  const facts = [];
  if (sizes.length) facts.push(`Müşterinin belirttiği numara(lar), sondan: ${[...new Set([...sizes].reverse())].slice(0, 3).join(', ')}`);
  if (shown.length) facts.push(`Daha önce gösterdiğimiz ürünler: ${shown.slice(-10).join('; ')}`);
  if (asked.length) facts.push(`Müşterinin son soruları: ${asked.slice(-4).join(' | ')}`);
  return [
    `## KONUŞMA HAFIZASI${e.name ? ` (müşteri: ${e.name})` : ''} — sohbetin başından bugüne, tarih sırasıyla (en eski üstte)`,
    'Bu müşteriyle daha önce yazıştık. Cevap vermeden önce aşağıdaki kaydı baştan sona oku ve sohbetin akışına göre devam et: sorduğu modeli, numarasını, gönderdiği görselleri, gösterdiğimiz ürünleri, fiyat/kampanya konuşulduysa bunu bil. Aynı şeyi tekrar sorma/anlatma; müşteri günler sonra yazsa bile kaldığı yerden yardımcı ol. "Sohbet geçmişinde görsel yok / anlayamadım" DEME; kayıt aşağıda.',
    ...(facts.length ? ['ÖZET: ' + facts.join(' || ')] : []),
    ...(e.older.length ? ['ESKİ KONUŞMALAR (kısaltılmış):', ...e.older.map((l) => l.slice(0, 150))] : []),
    'SON MESAJLAR:',
    ...e.msgs.map((m) => oneLine(m.r, m.m && !m.t ? '(görsel/paylaşım gönderdi)' : m.t, m.at).slice(0, 460)),
  ].join('\n');
}
