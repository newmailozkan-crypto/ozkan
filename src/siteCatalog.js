import { cfg } from './config.js';
import { decodeEntities, stripTags } from './util.js';
import { parseProductPage, scrapeSite } from './scrape.js';
import { httpGet } from './http.js';

// Site yedeği: XML okunamazsa ürünler WooCommerce sitesinden okunur.
//  1) WooCommerce Store API (/wp-json/wc/store/v1/products): ad, fiyat, görsel, açıklama, numara listesi (tüm ürünler, sayfa sayfa)
//  2) Store API numara stoklarını vermez: her ürün sayfasındaki varyasyon verisinden (scrape.js) numara stoğu eklenir
//  3) Store API kapalıysa scrape.js kategori sayfalarını gezip ürün sayfalarını okur
// Çıktı, catalog.js'in beklediği düz ürün nesneleridir (renk bazında, bedenleri içinde).

const SIZE_ATTR = /numara|beden|size/i;

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

const get = async (url, accept) => (await httpGet(url, { accept })).text;

// Aynı anda en fazla n iş; sonuç sırası korunur
async function pool(items, n, fn) {
  const out = new Array(items.length).fill(null);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try {
        out[k] = await fn(items[k], k);
      } catch (e) {
        console.error('[site]', e.message);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

const minorUnit = (prices) => (Number.isFinite(Number(prices?.currency_minor_unit)) ? Number(prices.currency_minor_unit) : 2);
const money = (v, unit) => (v === '' || v == null ? null : Number(v) / 10 ** unit || null);

// Store API ürününü düz ürün nesnesine çevirir. Yalnızca güncel (indirimli) fiyat alınır.
export function mapStoreProduct(p) {
  const unit = minorUnit(p.prices);
  const price = money(p.prices?.price, unit) || money(p.prices?.sale_price, unit);

  // numara listesi: önce numara/beden özniteliğinin terimleri, yoksa varyasyonların değerleri
  const sizeAttr = (p.attributes || []).find((a) => SIZE_ATTR.test(a.name || a.taxonomy || ''));
  let sizeNames = (sizeAttr?.terms || []).map((t) => t.name);
  if (!sizeNames.length) {
    sizeNames = (p.variations || [])
      .flatMap((v) => (v.attributes || []).filter((a) => SIZE_ATTR.test(a.name || '')).map((a) => a.value))
      .filter(Boolean);
  }
  // "35-45" gibi aralık yazıldıysa aç
  sizeNames = sizeNames.flatMap((n) => {
    const r = String(n).match(/^(\d{2})\s*[-–]\s*(\d{2})$/);
    if (!r) return [n];
    const out = [];
    for (let k = Number(r[1]); k <= Number(r[2]); k++) out.push(String(k));
    return out;
  });
  const inStock = p.is_in_stock !== false;
  const sizes = [...new Set(sizeNames.map(String))].map((s) => ({ size: s, stock: null, inStock }));

  const cats = (p.categories || []).map((c) => decodeEntities(c.name)).filter((n) => !/^(tüm ürünler|tum urunler|uncategorized|kategorisiz)$/i.test(n));
  return {
    id: String(p.id),
    title: decodeEntities(p.name),
    url: p.permalink,
    price,
    category: cats[0] || '',
    description: stripTags(p.short_description || p.description || '').slice(0, 600),
    images: [...new Set((p.images || []).map((i) => i.src).filter((u) => /^https?:\/\//.test(u)))],
    colorField: '',
    sizes,
    inStock,
    type: p.type,
  };
}

async function fetchStoreApi(base) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const arr = JSON.parse(await get(`${base}/wp-json/wc/store/v1/products?per_page=100&page=${page}`, 'application/json'));
    if (!Array.isArray(arr)) throw new Error('Store API beklenen biçimde değil');
    out.push(...arr);
    if (arr.length < 100) break;
  }
  return out.map(mapStoreProduct).filter((p) => p.title && p.price);
}

export async function fetchSiteProducts() {
  const base = originOf(cfg.siteCatalogUrl || cfg.feedUrl);
  if (!base) throw new Error('Site adresi bilinmiyor (SITE_CATALOG_URL veya PRODUCT_FEED_URL gerekli)');

  let list = null;
  let how = 'store-api';
  try {
    list = await fetchStoreApi(base);
    if (!list.length) throw new Error('Store API boş döndü');
  } catch (e) {
    console.warn('[site] Store API kullanılamadı:', e.message);
    if (!cfg.siteCatalogUrl) throw new Error('Store API kapalı ve SITE_CATALOG_URL (kategori sayfası) tanımlı değil');
    console.warn('[site] kategori sayfaları taranacak');
    list = (await scrapeSite()).filter((p) => p.title && p.price);
    how = 'html';
  }

  if (how === 'store-api') {
    // numara stoklarını ürün sayfalarından ekle (Store API vermiyor)
    const pages = await pool(list, 4, async (p) => {
      if (p.type && p.type !== 'variable') return null;
      return parseProductPage(await get(p.url, 'text/html'), p.url);
    });
    let n = 0;
    list.forEach((p, i) => {
      const sizes = pages[i]?.sizes;
      if (sizes?.length) {
        p.sizes = sizes;
        p.inStock = sizes.some((s) => s.inStock);
        n++;
      }
    });
    console.log(`[site] ${list.length} ürün Store API'den okundu, ${n} ürünün numara stoğu ürün sayfasından işlendi`);
  } else {
    console.log(`[site] ${list.length} ürün kategori sayfalarından okundu`);
  }
  return { list, how };
}
