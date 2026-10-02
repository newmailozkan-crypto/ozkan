import { XMLParser } from 'fast-xml-parser';
import { cfg } from './config.js';

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

let products = []; // normalize edilmiş, gruplanmış ürünler
let byId = new Map();
let lastUpdated = null;
let lastError = null;

// ---------- renk / model anahtarı ----------
const COLOR_WORDS = new Set([
  'siyah', 'beyaz', 'gri', 'lacivert', 'kahverengi', 'taba', 'bej', 'krem', 'kirmizi', 'mavi', 'yesil', 'sari',
  'pembe', 'mor', 'turuncu', 'bordo', 'antrasit', 'haki', 'ten', 'buz', 'fume', 'camel', 'gold', 'gumus', 'altin',
  'petrol', 'mint', 'lila', 'ekru', 'vizon', 'nude', 'navy', 'black', 'white', 'grey', 'gray', 'brown', 'red', 'blue', 'green',
]);
const asciiTokens = (s) =>
  String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const detectColor = (title) => asciiTokens(title).find((t) => COLOR_WORDS.has(t)) || '';
const stripColors = (title) => asciiTokens(title).filter((t) => !COLOR_WORDS.has(t)).join(' ');

// ---------- yardımcılar ----------
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const lower = (o) =>
  Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));

function text(v) {
  if (v == null) return '';
  if (typeof v === 'object') return text(Object.values(v)[0]);
  return String(v).trim();
}

function pick(raw, names) {
  for (const n of names) {
    const v = raw[n];
    if (v != null && text(v) !== '') return v;
  }
  return undefined;
}

export function parsePrice(v) {
  if (v == null) return null;
  let s = text(v).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lc = s.lastIndexOf(',');
  const ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) {
    s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lc > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (ld > -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stripHtml(s) {
  return text(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function availabilityFlag(v) {
  const s = text(v).toLowerCase();
  if (!s) return null;
  if (/(out.?of.?stock|stokta yok|tükendi|tukendi|yok|false|^0$|discontinued)/.test(s)) return false;
  if (/(in.?stock|stokta|var|true|^1$|mevcut|available|preorder)/.test(s)) return true;
  return null;
}

function stockNumber(v) {
  const s = text(v);
  if (s === '') return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// ---------- ürün listesini XML ağacında bul ----------
function findItems(node) {
  const KEYS = ['item', 'entry', 'product', 'urun', 'ürün', 'row'];
  let best = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      if (KEYS.includes(k.toLowerCase())) {
        const arr = toArray(v).filter((x) => x && typeof x === 'object');
        if (arr.length > best.length) best = arr;
      }
      if (typeof v === 'object') walk(v);
    }
  })(node);
  return best;
}

// ---------- bedenler ----------
function extractSizes(raw, itemAvail) {
  const out = [];
  const add = (size, stock, avail) => {
    const sz = text(size);
    if (!sz) return;
    let inStock;
    if (stock != null) inStock = stock > 0;
    else if (avail != null) inStock = avail;
    else inStock = itemAvail !== false;
    out.push({ size: sz, stock: stock ?? null, inStock });
  };

  const holder = pick(raw, ['variants', 'variant', 'varyantlar', 'varyant', 'secenekler', 'seçenekler', 'options', 'sizes', 'bedenler']);
  if (holder && typeof holder === 'object') {
    const list = toArray(
      holder.variant ?? holder.varyant ?? holder.option ?? holder.secenek ?? holder.size ?? holder.beden ?? holder.item ?? holder
    );
    for (const o of list) {
      if (o && typeof o === 'object') {
        const lo = lower(o);
        add(
          pick(lo, ['size', 'beden', 'numara', 'name', 'value', 'ozellik', 'title']),
          stockNumber(pick(lo, ['stock', 'stok', 'quantity', 'qty', 'miktar', 'stockamount'])),
          availabilityFlag(pick(lo, ['availability', 'stokdurumu', 'status']))
        );
      } else {
        add(o, null, null);
      }
    }
    if (out.length) return out;
  }

  const sizeVal = pick(raw, ['size', 'beden', 'numara', 'ayakkabinumarasi', 'ayakkabı_numarası']);
  if (sizeVal != null) {
    const parts = toArray(sizeVal).flatMap((x) => text(x).split(/[,;/|]/));
    const sq = stockNumber(pick(raw, ['quantity', 'stock', 'stok', 'stockamount', 'miktar']));
    for (const p of parts) add(p.trim(), parts.length === 1 ? sq : null, null);
  }
  return out;
}

// ---------- tek ürün normalize ----------
function normalize(rawIn) {
  const raw = lower(rawIn);
  const id = text(pick(raw, ['id', 'productid', 'product_id', 'sku', 'stockcode', 'stokkodu', 'urunid', 'code', 'barcode']));
  const title = text(pick(raw, ['title', 'name', 'productname', 'urunadi', 'urun_adi', 'baslik', 'label']));
  if (!id && !title) return null;

  const priceNormal = parsePrice(pick(raw, ['price', 'listprice', 'fiyat', 'normalfiyat', 'regularprice', 'pricewithvat', 'price1']));
  const priceSale = parsePrice(pick(raw, ['sale_price', 'saleprice', 'discountedprice', 'indirimlifiyat', 'special_price', 'campaignprice', 'price2']));
  const price = priceSale && (!priceNormal || priceSale <= priceNormal) ? priceSale : priceNormal;

  const imgs = [];
  const imageKeys = ['image_link', 'image', 'imageurl', 'picture', 'image1', 'resim', 'resim1', 'img', 'imglink', 'photo'];
  for (const k of imageKeys) toArray(raw[k]).forEach((x) => text(x) && imgs.push(text(x)));
  for (const k of ['additional_image_link', 'images', 'image2', 'image3', 'image4', 'resim2', 'resim3', 'resim4', 'pictures']) {
    const v = raw[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.values(v).flatMap(toArray).forEach((x) => text(x) && imgs.push(text(x)));
    } else {
      toArray(v).forEach((x) => text(x) && imgs.push(text(x)));
    }
  }
  const images = [...new Set(imgs.filter((u) => /^https?:\/\//i.test(u)))];

  const availFlag = availabilityFlag(pick(raw, ['availability', 'stokdurumu', 'stock_status', 'stockstatus', 'durum']));
  const sizes = extractSizes(raw, availFlag);

  let inStock;
  if (sizes.length) inStock = sizes.some((s) => s.inStock);
  else {
    const q = stockNumber(pick(raw, ['quantity', 'stock', 'stok', 'stockamount', 'miktar']));
    inStock = q != null ? q > 0 : availFlag !== false;
  }

  const brand = text(pick(raw, ['brand', 'marka', 'manufacturer']));
  const color = text(pick(raw, ['color', 'renk'])) || detectColor(title);
  const modelCode = text(pick(raw, ['model', 'modelcode', 'model_code', 'mpn', 'modelkodu']));
  // Aynı modelin farklı renklerini bağlayan anahtar: model kodu varsa o, yoksa renk kelimeleri çıkarılmış başlık
  const modelKey = asciiTokens(modelCode || `${brand} ${stripColors(title)}`).join(' ') || String(id || title);
  const groupId = text(pick(raw, ['item_group_id', 'group_id', 'groupid', 'parentid', 'parent_id'])) || null;

  return {
    id: id || title,
    groupId,
    groupKey: groupId ? `${groupId}|${asciiTokens(color).join('')}` : null, // aynı renk + farklı beden satırlarını birleştirir
    modelKey,
    title,
    brand,
    category: text(pick(raw, ['product_type', 'category', 'kategori', 'categorypath', 'google_product_category'])),
    color,
    description: stripHtml(pick(raw, ['description', 'aciklama', 'açıklama', 'detail', 'detay', 'content'])).slice(0, 600),
    price,
    priceOriginal: priceNormal && price && priceNormal > price ? priceNormal : null,
    currency: text(pick(raw, ['currency', 'parabirimi'])) || 'TL',
    url: text(pick(raw, ['link', 'url', 'producturl', 'urunlink', 'permalink'])),
    images,
    sizes,
    inStock,
  };
}

// Aynı model/renk varyantlarını (satır başına bir beden) tek ürüne birleştir
function groupVariants(list) {
  const groups = new Map();
  const out = [];
  for (const p of list) {
    if (!p.groupKey) {
      out.push(p);
      continue;
    }
    const g = groups.get(p.groupKey);
    if (!g) {
      const slug = asciiTokens(p.color).join('');
      groups.set(p.groupKey, { ...p, sizes: [...p.sizes], id: slug ? `${p.groupId}-${slug}` : p.groupId });
    } else {
      for (const s of p.sizes) {
        if (!g.sizes.find((x) => x.size === s.size)) g.sizes.push(s);
      }
      if (!g.images.length) g.images = p.images;
      g.inStock = g.inStock || p.inStock;
    }
  }
  return [...out, ...groups.values()];
}

export function parseFeed(xml) {
  const tree = parser.parse(xml);
  const items = findItems(tree);
  const normalized = items.map(normalize).filter(Boolean);
  const grouped = groupVariants(normalized);
  return grouped.filter((p) => p.title && p.price);
}

// ---------- yenileme ----------
export async function refreshCatalog() {
  if (!cfg.feedUrl) throw new Error('PRODUCT_FEED_URL tanımlı değil');
  try {
    const res = await fetch(cfg.feedUrl, { headers: { 'User-Agent': 'ig-satis-botu/1.0' } });
    if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
    const xml = await res.text();
    const list = parseFeed(xml);
    if (!list.length) throw new Error('Feed ayrıştırıldı ama ürün bulunamadı (alan adlarını kontrol edin)');
    products = list;
    byId = new Map(list.map((p) => [String(p.id), p]));
    lastUpdated = new Date();
    lastError = null;
    console.log(`[catalog] ${list.length} ürün yüklendi (${list.filter((p) => p.inStock).length} stokta)`);
  } catch (e) {
    lastError = e.message;
    console.error('[catalog] yenileme hatası:', e.message);
  }
}

export function startCatalogRefresh() {
  refreshCatalog();
  setInterval(refreshCatalog, cfg.feedRefreshMin * 60 * 1000).unref?.();
}

export function catalogStatus() {
  return { count: products.length, lastUpdated, lastError };
}

// Test amaçlı: listeyi doğrudan yükle
export function setProducts(list) {
  products = list;
  byId = new Map(list.map((p) => [String(p.id), p]));
}

// ---------- sorgular ----------
const norm = (s) =>
  String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/[çÇ]/g, 'c')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[ıİ]/g, 'i')
    .replace(/[öÖ]/g, 'o')
    .replace(/[şŞ]/g, 's')
    .replace(/[üÜ]/g, 'u');

export function hasSize(p, size) {
  if (!size) return true;
  if (!p.sizes.length) return p.inStock;
  return p.sizes.some((s) => s.inStock && norm(s.size) === norm(size));
}

export function getProduct(id) {
  return byId.get(String(id)) || null;
}

export function searchProducts({ query = '', size, maxPrice, limit = 8, excludeIds = [], inStockOnly = true } = {}) {
  const tokens = norm(query).split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const ex = new Set(excludeIds.map(String));
  const scored = [];
  for (const p of products) {
    if (ex.has(String(p.id))) continue;
    if (inStockOnly && !p.inStock) continue;
    if (size && !hasSize(p, size)) continue;
    if (maxPrice && p.price > maxPrice) continue;
    let score = 0;
    if (tokens.length) {
      const hay = norm([p.title, p.brand, p.category, p.color, p.description].join(' '));
      const titleHay = norm(p.title);
      for (const t of tokens) {
        if (titleHay.includes(t)) score += 3;
        else if (hay.includes(t)) score += 1;
      }
      if (!score) continue;
    }
    scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.p);
}

// Aynı modelin (aynı model anahtarı) diğer renkleri; size verilirse sadece o numarası stokta olanlar
export function otherColors(p, size) {
  return products.filter(
    (x) => x.id !== p.id && x.modelKey === p.modelKey && x.inStock && hasSize(x, size) && x.color.toLowerCase() !== p.color.toLowerCase()
  );
}

// Metin tabanlı benzerlik: kategori, marka, başlık kelimeleri ve fiyat yakınlığı
export function similarProducts(p, size, limit = 6) {
  const base = new Set(asciiTokens(stripColors(p.title)));
  const scored = [];
  for (const x of products) {
    if (x.id === p.id || x.modelKey === p.modelKey || !x.inStock || !hasSize(x, size)) continue;
    let score = 0;
    if (p.category && x.category && norm(x.category) === norm(p.category)) score += 3;
    if (p.brand && x.brand && norm(x.brand) === norm(p.brand)) score += 2;
    for (const t of asciiTokens(stripColors(x.title))) if (base.has(t)) score += 1;
    if (p.price && Math.abs(x.price - p.price) / p.price <= 0.3) score += 1;
    if (score > 0) scored.push({ x, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.x);
}

export function suggestForSize(size, excludeIds = [], count = 8, preferCategory = '') {
  const pool = searchProducts({ size, excludeIds, limit: 200 });
  const pc = norm(preferCategory);
  const same = pc ? pool.filter((p) => norm(p.category).includes(pc)) : [];
  const rest = pool.filter((p) => !same.includes(p));
  const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  return [...shuffle(same), ...shuffle(rest)].slice(0, count);
}

// Model'e gidecek kısa ürün özeti
export function brief(p, size) {
  return {
    id: p.id,
    baslik: p.title,
    marka: p.brand || undefined,
    kategori: p.category || undefined,
    renk: p.color || undefined,
    fiyat_tl: p.price,
    eski_fiyat_tl: p.priceOriginal || undefined,
    stokta_olan_bedenler: p.sizes.filter((s) => s.inStock).map((s) => s.size),
    secilen_beden_stokta: size ? hasSize(p, size) : undefined,
    aciklama: p.description || undefined,
    link: p.url || undefined,
    gorsel_var: p.images.length > 0,
  };
}
