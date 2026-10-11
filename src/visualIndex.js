import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { create } from './claude.js';
import { getImage } from './images.js';

// Görsel hafıza: her ürün görseli bir kez tanımlanır ve bellekte tutulur (görsel adresi -> tanım).
// Böylece müşteri fotoğrafı geldiğinde ve "benzer ürün" önerirken her seferinde tüm görselleri baştan yorumlamak gerekmez.
const cache = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cfg.visualFile, 'utf8')))) cache.set(k, v);
  console.log(`[visual] ${cache.size} görsel tanımı diskten yüklendi (yeniden ücret ödenmez)`);
} catch {
  /* dosya yok */
}
let saveT = null;
function persist() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(cfg.visualFile), { recursive: true });
      fs.writeFileSync(cfg.visualFile, JSON.stringify(Object.fromEntries(cache)));
    } catch {
      /* önemsiz */
    }
  }, 2000);
  saveT.unref?.();
}
let running = false;
let listener = null;
let lastUrls = [];
let retryCount = 0;
let failed = 0;
// Hafıza ilerledikçe (her 10 tanımda) katalog ürünlerine bağlanır: tüm indeksin bitmesi beklenmez
export const setVisualListener = (fn) => { listener = fn; };
export const visualStatus = () => ({ tanimli: cache.size, calisiyor: running, hata: failed, yeniden_deneme: retryCount });

export const getVisual = (url) => cache.get(url) || null;
export const visualCount = () => cache.size;

const PROMPT = `Bu bir ürün (ayakkabı, bot, çanta vb.) fotoğrafı. Ürünü kataloglama için tanımla.
Yalnızca JSON döndür, Türkçe yaz:
{"tur":"bot|çizme|sneaker|spor ayakkabı|terlik|topuklu|babet|sandalet|loafer|diğer","renk":"ana renk","stil":"2-4 kelimelik stil (örn. platform kürklü mini bot, retro sneaker)","taban":"düz|platform|topuklu|kalın taban|...","materyal":"süet|deri|kumaş|...","desen":"düz|leopar|desenli|...","logo":"görünen logo/şerit/işaret (örn. Nike tik, New Balance N, 3 şerit, Puma figürü, yok)","ozet":"en fazla 18 kelimelik görsel özet"}`;

function parseDescription(r) {
  const t = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]);
  const v = {
    tur: String(j.tur || ''),
    renk: String(j.renk || ''),
    stil: String(j.stil || ''),
    taban: String(j.taban || ''),
    materyal: String(j.materyal || ''),
    desen: String(j.desen || ''),
    logo: String(j.logo || ''),
    ozet: String(j.ozet || ''),
  };
  v.text = [v.tur, v.renk, v.stil, v.taban, v.materyal, v.desen, v.logo, v.ozet].filter(Boolean).join(' ');
  return v;
}

async function describeImg(img) {
  const r = await create({
    model: cfg.indexModel,
    max_tokens: 240,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.b64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  }, 'gorsel_hafiza');
  return parseDescription(r);
}

const describe = async (url) => describeImg(await getImage(url, { maxSide: 384 }));

// Müşterinin gönderdiği fotoğrafı, katalogdaki görsel hafızayla AYNI sözlükle tanımlar (hızlı model ile)
export const describeCustomerImage = (img) => describeImg(img);

// Henüz tanımlanmamış görselleri arka planda tanımlar. Dönen sayı: bu çalışmada eklenen tanım adedi.
export async function indexVisuals(urls) {
  lastUrls = [...new Set([...lastUrls, ...urls])];
  if (running) return 0; // çalışan iş bitince lastUrls'taki eksikler tekrar denenir
  running = true;
  let done = 0;
  failed = 0;
  try {
    const queue = [...new Set(lastUrls)].filter((u) => u && !cache.has(u));
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        try {
          const v = await describe(u);
          if (v) {
            cache.set(u, v);
            done++;
            if (done % 10 === 0) { try { listener?.(); } catch { /* yoksay */ } persist(); }
          }
        } catch (e) {
          failed++;
          console.error('[visual] tanımlanamadı:', u, e.message);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (done) persist();
  } finally {
    running = false;
  }
  if (done) console.log(`[visual] ${done} ürün görseli tanımlandı (toplam ${cache.size})`);
  // Hata olduysa veya çalışırken yeni görsel geldiyse 3 dk sonra eksikleri tekrar dene (en çok 8 kez)
  const missing = lastUrls.filter((u) => u && !cache.has(u)).length;
  if (missing && retryCount < 8 && (failed || done)) {
    retryCount++;
    setTimeout(() => indexVisuals([]).then((n) => n && listener?.()).catch(() => {}), 3 * 60 * 1000).unref?.();
  } else if (!missing) retryCount = 0;
  return done;
}
