import { cfg } from './config.js';
import { httpGet } from './http.js';

// Yedek kaynak: WooCommerce sitesinden ürünleri okur (XML okunamazsa).
//  1) Kategori sayfasını /page/2/, /page/3/ ... diye gezip ürün sayfası linklerini toplar.
//  2) Her ürün sayfasından ad, açıklama, fiyat, görsel ve numara/stok bilgisini alır.
//     Numara ve stok, WooCommerce'in ürün formuna gömdüğü data-product_variations JSON'undan okunur.

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ig-satis-botu/1.0)' };

const decode = (s) =>
  String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

const stripTags = (s) => decode(String(s || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

async function getHtml(url) {
  return (await httpGet(url, { accept: 'text/html,application/xhtml+xml', timeoutMs: 25000 })).text;
}

// ---------- kategori sayfası ----------
export function parseListing(html, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const links = new Set();
  const re = /<a\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const href = (attrs.match(/\bhref\s*=\s*"([^"]+)"/i) || [])[1];
    if (!href) continue;
    const cls = (attrs.match(/\bclass\s*=\s*"([^"]*)"/i) || [])[1] || '';
    let abs;
    try {
      abs = new URL(decode(href), pageUrl);
    } catch {
      continue;
    }
    if (abs.origin !== origin) continue;
    const isLoop = /woocommerce-LoopProduct-link/.test(cls);
    const isProductPath = abs.pathname.includes(cfg.siteProductPath) && abs.pathname.length > cfg.siteProductPath.length + 1;
    if (isLoop || isProductPath) links.add(abs.origin + abs.pathname);
  }
  return [...links];
}

export async function collectProductUrls() {
  const base = cfg.siteCatalogUrl.replace(/\/+$/, '');
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 40; page++) {
    const url = page === 1 ? `${base}/` : `${base}/page/${page}/`;
    let html;
    try {
      html = await getHtml(url);
    } catch (e) {
      if (page === 1) throw e;
      break; // sayfa yoksa (404) bitti
    }
    const links = parseListing(html, url).filter((u) => !seen.has(u));
    if (!links.length) break;
    links.forEach((u) => {
      seen.add(u);
      all.push(u);
    });
  }
  return all;
}

// ---------- ürün sayfası ----------
function jsonLdProducts(html) {
  const out = [];
  const re = /<script[^>]*type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1]);
      const nodes = Array.isArray(j) ? j : j['@graph'] ? j['@graph'] : [j];
      for (const n of nodes) if (n && /Product/i.test([].concat(n['@type']).join(','))) out.push(n);
    } catch {
      /* geçersiz JSON-LD'yi atla */
    }
  }
  return out;
}

const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*"${prop}"[^>]*content\\s*=\\s*"([^"]*)"`, 'i')) || html.match(new RegExp(`<meta[^>]+content\\s*=\\s*"([^"]*)"[^>]*(?:property|name)\\s*=\\s*"${prop}"`, 'i'));
  return m ? decode(m[1]) : '';
};

function variations(html) {
  const m = html.match(/data-product_variations\s*=\s*"([^"]*)"/i) || html.match(/data-product_variations\s*=\s*'([^']*)'/i);
  if (!m) return [];
  try {
    const arr = JSON.parse(decode(m[1]));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function parseProductPage(html, url) {
  const ld = jsonLdProducts(html)[0] || {};
  const vars = variations(html);

  const title =
    stripTags((html.match(/<h1[^>]*class\s*=\s*"[^"]*product_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) ||
    decode(ld.name || '') ||
    meta(html, 'og:title').replace(/\s*[-–|].*$/, '');
  if (!title) return null;

  // numara + stok (varyasyonlardan)
  const sizes = [];
  let colorFromAttr = '';
  for (const v of vars) {
    const attrs = v.attributes || {};
    let size = null;
    for (const [k, val] of Object.entries(attrs)) {
      if (/numara|beden|size/i.test(k) && val) size = String(val);
      else if (/renk|color|colour/i.test(k) && val && !colorFromAttr) colorFromAttr = String(val).replace(/[-_]+/g, ' ');
    }
    if (!size) continue;
    const maxQty = v.max_qty === '' || v.max_qty == null ? null : num(v.max_qty) ?? (Number(v.max_qty) === 0 ? 0 : null);
    const inStock = v.is_in_stock !== false && (maxQty === null || maxQty > 0) && v.is_purchasable !== false;
    sizes.push({ size, stock: maxQty, inStock });
  }
  // varyasyon JSON'u yoksa form seçeneklerinden (stok bilgisi olmadan) oku
  if (!sizes.length) {
    const sel = html.match(/<select[^>]*name\s*=\s*"attribute_pa_(?:numara|beden|size)[^"]*"[^>]*>([\s\S]*?)<\/select>/i);
    if (sel) {
      const re = /<option[^>]*value\s*=\s*"([^"]+)"/gi;
      let o;
      while ((o = re.exec(sel[1]))) sizes.push({ size: decode(o[1]), stock: null, inStock: true });
    }
  }

  // fiyat: yalnızca güncel (indirimli) fiyat tutulur
  const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers || {};
  const varPrices = vars.map((v) => num(v.display_price)).filter(Boolean);
  const price =
    (varPrices.length ? Math.min(...varPrices) : null) ||
    num(offer.price) ||
    num(offer.lowPrice) ||
    num(meta(html, 'product:price:amount')) ||
    null;

  // görseller
  const imgs = [];
  const ldImg = ld.image;
  for (const i of [].concat(ldImg || [])) imgs.push(typeof i === 'string' ? i : i?.url);
  const gallery = [...html.matchAll(/data-large_image\s*=\s*"([^"]+)"/gi)].map((x) => decode(x[1]));
  imgs.unshift(...gallery.slice(0, 1));
  imgs.push(meta(html, 'og:image'));
  const images = [...new Set(imgs.filter((u) => /^https?:\/\//i.test(u || '')))].slice(0, 4);

  // id
  const id =
    String(ld.sku || '') ||
    (html.match(/data-product_id\s*=\s*"(\d+)"/i) || [])[1] ||
    (html.match(/name\s*=\s*"add-to-cart"[^>]*value\s*=\s*"(\d+)"/i) || [])[1] ||
    new URL(url).pathname.replace(/\/+$/, '').split('/').pop();

  const cat = html.match(/<a[^>]+href\s*=\s*"[^"]*\/product-category\/[^"]*"[^>]*rel\s*=\s*"tag"[^>]*>([\s\S]*?)<\/a>/i);
  const description = stripTags(ld.description || meta(html, 'og:description') || (html.match(/woocommerce-product-details__short-description[^>]*>([\s\S]*?)<\/div>/i) || [])[1]).slice(0, 600);

  // ürün sayfasında hiç numara/stok işareti yoksa ve "stokta yok" yazıyorsa
  const soldOut = !sizes.length && (/outofstock/i.test(JSON.stringify(offer)) || /class\s*=\s*"[^"]*out-of-stock/i.test(html));

  return {
    id: String(id),
    title: decode(title),
    description,
    price,
    url: new URL(url).origin + new URL(url).pathname,
    images,
    category: cat ? stripTags(cat[1]) : '',
    colorField: colorFromAttr,
    sizes,
    inStock: sizes.length ? sizes.some((s) => s.inStock) : !soldOut,
  };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        const r = await fn(items[idx]);
        if (r) out.push(r);
      } catch (e) {
        console.error('[scrape] ürün okunamadı:', items[idx], e.message);
      }
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

export async function scrapeSite() {
  if (!cfg.siteCatalogUrl) throw new Error('SITE_CATALOG_URL tanımlı değil');
  const urls = await collectProductUrls();
  if (!urls.length) throw new Error('Kategori sayfasında ürün linki bulunamadı');
  console.log(`[scrape] ${urls.length} ürün sayfası okunacak`);
  const items = await pool(urls, 4, async (u) => parseProductPage(await getHtml(u), u));
  return items;
}
