import Anthropic from '@anthropic-ai/sdk';
import { cfg } from './config.js';
import { getImage } from './images.js';

// Görsel hafıza: her ürün görseli bir kez tanımlanır ve bellekte tutulur (görsel adresi -> tanım).
// Böylece müşteri fotoğrafı geldiğinde ve "benzer ürün" önerirken her seferinde tüm görselleri baştan yorumlamak gerekmez.
const client = new Anthropic({ apiKey: cfg.anthropicKey });
const cache = new Map();
let running = false;

export const getVisual = (url) => cache.get(url) || null;
export const visualCount = () => cache.size;

const PROMPT = `Bu bir ürün (ayakkabı, bot, çanta vb.) fotoğrafı. Ürünü kataloglama için tanımla.
Yalnızca JSON döndür, Türkçe yaz:
{"tur":"bot|çizme|sneaker|spor ayakkabı|terlik|topuklu|babet|sandalet|loafer|diğer","renk":"ana renk","stil":"2-4 kelimelik stil (örn. platform kürklü mini bot, retro sneaker)","taban":"düz|platform|topuklu|kalın taban|...","materyal":"süet|deri|kumaş|...","desen":"düz|leopar|desenli|...","ozet":"en fazla 18 kelimelik görsel özet"}`;

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
    ozet: String(j.ozet || ''),
  };
  v.text = [v.tur, v.renk, v.stil, v.taban, v.materyal, v.desen, v.ozet].filter(Boolean).join(' ');
  return v;
}

async function describeImg(img) {
  const r = await client.messages.create({
    model: cfg.indexModel,
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.b64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  return parseDescription(r);
}

const describe = async (url) => describeImg(await getImage(url, { maxSide: 512 }));

// Müşterinin gönderdiği fotoğrafı, katalogdaki görsel hafızayla AYNI sözlükle tanımlar (hızlı model ile)
export const describeCustomerImage = (img) => describeImg(img);

// Henüz tanımlanmamış görselleri arka planda tanımlar. Dönen sayı: bu çalışmada eklenen tanım adedi.
export async function indexVisuals(urls) {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    const queue = [...new Set(urls)].filter((u) => u && !cache.has(u));
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        try {
          const v = await describe(u);
          if (v) {
            cache.set(u, v);
            done++;
          }
        } catch (e) {
          console.error('[visual] tanımlanamadı:', u, e.message);
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    running = false;
  }
  if (done) console.log(`[visual] ${done} ürün görseli tanımlandı (toplam ${cache.size})`);
  return done;
}
