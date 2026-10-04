import crypto from 'node:crypto';
import { cfg } from './config.js';

// sharp isteğe bağlıdır: varsa webp/avif -> jpeg dönüştürür ve görselleri küçültür.
let sharp = null;
let sharpTried = false;

export async function initImages() {
  if (sharpTried) return !!sharp;
  sharpTried = true;
  try {
    sharp = (await import('sharp')).default;
    console.log('[images] sharp yüklü: webp -> jpeg dönüştürme aktif');
  } catch {
    console.warn('[images] sharp yüklenemedi: webp görseller Instagram için dönüştürülemeyecek');
  }
  return !!sharp;
}

const MAX_CACHE = 300;
const cache = new Map();
function remember(key, val) {
  cache.set(key, val);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

function guessType(url) {
  const m = String(url).toLowerCase().match(/\.(jpe?g|png|gif|webp|avif)(\?|$)/);
  if (!m) return 'image/jpeg';
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }[m[1]];
}

// Görseli indirir; sharp varsa en uzun kenarı maxSide'a küçültüp JPEG yapar. Claude'a base64 olarak verilir.
export async function getImage(url, { maxSide = 768, useCache = true } = {}) {
  const key = `${maxSide}|${url}`;
  if (useCache && cache.has(key)) return cache.get(key);

  const res = await fetch(url, { headers: { 'User-Agent': 'ig-satis-botu/1.0' } });
  if (!res.ok) throw new Error(`Görsel indirilemedi (${res.status}): ${url}`);
  let buf = Buffer.from(await res.arrayBuffer());
  let mediaType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!mediaType.startsWith('image/')) mediaType = guessType(url);

  if (sharp) {
    try {
      buf = await sharp(buf)
        .rotate()
        .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      mediaType = 'image/jpeg';
    } catch (e) {
      console.error('[images] dönüştürülemedi:', url, e.message);
    }
  }
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) mediaType = 'image/jpeg';
  if (buf.length > 5 * 1024 * 1024) throw new Error('Görsel çok büyük (5 MB üstü)');

  const out = { buf, mediaType, b64: buf.toString('base64') };
  if (useCache) remember(key, out);
  return out;
}

// ---- Instagram'a gönderilecek görsel adresi ----
// Instagram DM'de webp desteklenmeyebilir; bu yüzden webp/avif görselleri kendi sunucumuzdan JPEG olarak sunarız.
const registry = new Map(); // id -> özgün görsel adresi (yalnızca katalogdaki adresler, açık proxy olmasın)

export function instagramImageUrl(url) {
  if (!url) return url;
  if (!cfg.convertWebp) return url; // varsayılan: görsel adresi olduğu gibi gider (Instagram webp'i destekliyor)
  if (!/\.(webp|avif)(\?|$)/i.test(url)) return url;
  if (!cfg.convertWebp) return url; // Instagram webp'i destekliyor: özgün adresi olduğu gibi gönder
  if (!sharp || !cfg.publicUrl) return url; // dönüştürme yoksa özgün adres (en iyi çaba)
  const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  registry.set(id, url);
  return `${cfg.publicUrl}/img/${id}.jpg`;
}

export async function serveImage(id) {
  const url = registry.get(id);
  if (!url) return null;
  return getImage(url, { maxSide: 1080 });
}

// Bellekteki bir görseli Claude için hazırlar (küçültür, JPEG yapar)
export async function fromBuffer(buf, { maxSide = 1024 } = {}) {
  let mediaType = 'image/jpeg';
  if (sharp) {
    try {
      buf = await sharp(buf).rotate().resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    } catch (e) {
      throw new Error('Görsel işlenemedi: ' + e.message);
    }
  }
  if (buf.length > 5 * 1024 * 1024) throw new Error('Görsel çok büyük (5 MB üstü)');
  return { buf, mediaType, b64: buf.toString('base64') };
}

// Algısal parmak izi (dHash, 64 bit): müşterinin geri gönderdiği kendi fotoğrafımızı tanımak için
export async function dhash(buf) {
  if (!sharp) return null;
  try {
    const px = await sharp(buf).rotate().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
    let h = 0n;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
    return h;
  } catch {
    return null;
  }
}

export function hamming(a, b) {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
