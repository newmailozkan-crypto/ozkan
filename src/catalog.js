import { XMLParser } from 'fast-xml-parser';
import { cfg } from './config.js';
import { getVisual, indexVisuals, visualCount } from './visualIndex.js';
import { parsePrice, decodeEntities } from './util.js';
import { fetchSiteProducts } from './siteCatalog.js';
import { httpGet } from './http.js';
import { sendTelegram } from './telegram.js';
import { redact } from './util.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export { parsePrice };

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

let products = []; // renk bazında tek ürün (bedenleri içinde), bellekte tutulur
let byId = new Map();
let lastUpdated = null;
let lastError = null;
let lastRawSample = [];
let lastItemCount = 0;

// ---------- metin yardımcıları ----------
const asciiTokens = (s) =>
  String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const asciiTok = (w) => asciiTokens(w).join('');
const norm = (s) => asciiTokens(s).join(' ');

const COLOR_WORDS = new Set([
  'siyah', 'beyaz', 'gri', 'lacivert', 'kahverengi', 'kahve', 'aci', 'taba', 'bej', 'krem', 'kirmizi', 'mavi', 'yesil', 'sari',
  'pembe', 'mor', 'turuncu', 'bordo', 'antrasit', 'haki', 'ten', 'buz', 'fume', 'camel', 'gold', 'gumus', 'altin', 'petrol',
  'mint', 'lila', 'ekru', 'vizon', 'nude', 'leopar', 'zebra', 'yilan', 'sampanya', 'pudra', 'hardal', 'murdum', 'fusya', 'bakir',
  'navy', 'black', 'white', 'grey', 'gray', 'brown', 'red', 'blue', 'green',
]);

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const lower = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));

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

function cleanCategory(s) {
  return decodeEntities(s).replace(/^\s*(home|ana sayfa|anasayfa)\s*>\s*/i, '').replace(/\s*>\s*/g, ' > ').trim();
}

function stripHtml(s) {
  return decodeEntities(text(s))
    .replace(/<[^>]*>/g, ' ')
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

// "37", "37 Numara", "37 (EU)", "37,5" gibi yazımları aynı sayıya indirger; harfli bedenlerde (S, M, L) metin karşılaştırır
const sizeKey = (s) => {
  const m = String(s ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? m[0] : norm(s);
};
const sizeNum = (s) => {
  const n = Number(sizeKey(s));
  return Number.isFinite(n) ? n : 9999;
};

// ---------- ürün linkinden beden / renk ----------
// Bu tür WooCommerce feed'lerinde beden ayrı bir alan değil, linkte gelir: ...?attribute_pa_numara=37
function parseLink(link) {
  const empty = { base: '', size: null, sizeParam: null, color: null };
  if (!link) return empty;
  try {
    const u = new URL(link);
    const out = { base: u.origin + u.pathname, size: null, sizeParam: null, color: null };
    for (const [k, v] of u.searchParams) {
      const kk = k.toLowerCase();
      if (/^attribute_(pa_)?(numara|beden|size|ayakkabi_?numarasi|ayakkabi-?numarasi)$/.test(kk)) {
        out.size = v;
        out.sizeParam = k;
      } else if (/^attribute_(pa_)?(renk|color|colour)$/.test(kk)) {
        out.color = v.replace(/[-_]+/g, ' ');
      }
    }
    return out;
  } catch {
    return { ...empty, base: String(link).split('?')[0] };
  }
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

// ---------- bedenler (ayrı alan / varyant etiketi olan feed'ler için) ----------
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
    const h = Array.isArray(holder) ? {} : lower(holder); // <Variants><Variant> gibi büyük harfli etiketler için
    const list = toArray(h.variant ?? h.varyant ?? h.option ?? h.secenek ?? h.size ?? h.beden ?? h.item ?? holder);
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

// ---------- tek kayıt normalize ----------
function normalize(rawIn) {
  const raw = lower(rawIn);
  const id = text(pick(raw, ['id', 'productid', 'product_id', 'sku', 'stockcode', 'stokkodu', 'urunid', 'code', 'barcode']));
  const title = decodeEntities(text(pick(raw, ['title', 'name', 'productname', 'urunadi', 'urun_adi', 'baslik', 'label'])));
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

  const link = parseLink(text(pick(raw, ['link', 'url', 'producturl', 'urunlink', 'permalink'])));
  const availFlag = availabilityFlag(pick(raw, ['availability', 'stokdurumu', 'stock_status', 'stockstatus', 'durum']));

  let sizes = extractSizes(raw, availFlag);
  if (!sizes.length && link.size) sizes = [{ size: String(link.size), stock: null, inStock: availFlag !== false }];

  let inStock;
  if (sizes.length) inStock = sizes.some((s) => s.inStock);
  else {
    const q = stockNumber(pick(raw, ['quantity', 'stock', 'stok', 'stockamount', 'miktar']));
    inStock = q != null ? q > 0 : availFlag !== false;
  }

  const colorField = text(pick(raw, ['color', 'renk'])) || link.color || '';
  const groupId = text(pick(raw, ['item_group_id', 'group_id', 'groupid', 'parentid', 'parent_id'])) || null;
  const description = stripHtml(pick(raw, ['description', 'aciklama', 'açıklama', 'detail', 'detay', 'content'])).slice(0, 1500);
  const groupBase = groupId || link.base || null;

  return {
    id: id || title,
    groupId,
    // aynı ürünün beden satırlarını tek ürüne birleştirir; renk ayrı alan/linkte geliyorsa renkleri de ayırır
    groupKey: groupBase ? `${groupBase}|${asciiTok(colorField)}` : null,
    descSig: asciiTokens(description).join('').slice(0, 160),
    colorField,
    modelName: '',
    modelKey: '',
    title,
    brand: text(pick(raw, ['brand', 'marka', 'manufacturer'])),
    category: cleanCategory(text(pick(raw, ['product_type', 'category', 'kategori', 'categorypath', 'google_product_category']))),
    color: colorField,
    description,
    price,
    priceOriginal: priceNormal && price && priceNormal > price ? priceNormal : null,
    currency: text(pick(raw, ['currency', 'parabirimi'])) || 'TL',
    url: link.base || text(pick(raw, ['link', 'url'])),
    sizeParam: link.sizeParam,
    images,
    sizes,
    inStock,
    visual: null,
    visuals: [],
    visualText: '',
  };
}

// ---------- model ve renk ayrımı ----------
// Bu feed'de renk ayrı alan değil, başlığın sonunda: "Platform Acı Kahve", "Platform Taba", "Tazz Vizon".
// 1) Aynı açıklama metnini paylaşan kayıtlar aynı modelin renkleridir: başlıkların ortak başı model adı, kalanı renktir.
// 2) Bu olmazsa başlıktaki bilinen renk kelimeleri renk, kalanı model adı sayılır.
function splitTitle(title) {
  const words = title.split(/\s+/).filter(Boolean);
  const colorWords = words.filter((w) => COLOR_WORDS.has(asciiTok(w)));
  const nameWords = words.filter((w) => !COLOR_WORDS.has(asciiTok(w)));
  return { modelName: (nameWords.length ? nameWords : words).join(' '), color: colorWords.join(' ') };
}

function assignModels(items) {
  const bySig = new Map();
  for (const p of items) {
    if (p.descSig.length < 40) continue;
    if (!bySig.has(p.descSig)) bySig.set(p.descSig, []);
    bySig.get(p.descSig).push(p);
  }
  const done = new Set();
  for (const group of bySig.values()) {
    const titles = [...new Set(group.map((p) => p.title))];
    if (titles.length < 2) continue;
    const toks = titles.map((t) => t.split(/\s+/).filter(Boolean));
    let n = 0;
    while (toks.every((t) => t[n] && asciiTok(t[n]) === asciiTok(toks[0][n]))) n++;
    // "Elevate Beyaz Gri" + "Elevate Beyaz Lacivert": ortak başta kalan "Beyaz" renktir, model adı değil
    while (n > 0 && COLOR_WORDS.has(asciiTok(toks[0][n - 1]))) n--;
    if (n >= 1 && toks.every((t) => t.length > n)) {
      const modelName = toks[0].slice(0, n).join(' ');
      for (const p of group) {
        p.modelName = modelName;
        p.color = p.colorField || p.title.split(/\s+/).filter(Boolean).slice(n).join(' ');
        done.add(p);
      }
    }
  }
  for (const p of items) {
    if (!done.has(p)) {
      const s = splitTitle(p.title);
      p.modelName = s.modelName;
      p.color = p.colorField || s.color;
    }
    p.modelKey = asciiTokens(p.modelName).join(' ') || String(p.id);
  }
}

// Beden satırlarını (her biri ayrı kayıt) renk bazında tek ürüne birleştir
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
      groups.set(p.groupKey, { ...p, sizes: [...p.sizes], images: [...p.images], id: p.groupId || p.id });
    } else {
      for (const s of p.sizes) {
        const ex = g.sizes.find((x) => sizeKey(x.size) === sizeKey(s.size));
        if (!ex) g.sizes.push(s);
        else if (s.inStock) ex.inStock = true;
      }
      if (!g.images.length) g.images = p.images;
      g.inStock = g.inStock || p.inStock;
    }
  }
  const merged = [...out, ...groups.values()];
  for (const p of merged) p.sizes.sort((a, b) => sizeNum(a.size) - sizeNum(b.size));
  return merged;
}

export function parseFeed(xml) {
  const tree = parser.parse(xml);
  const items = findItems(tree);
  lastRawSample = items.slice(0, 2);
  lastItemCount = items.length;
  const normalized = items.map(normalize).filter(Boolean);
  assignModels(normalized);
  const grouped = groupVariants(normalized);
  return grouped.filter((p) => p.title && p.price);
}

// ---------- hafıza ----------
function setProductsInternal(list) {
  products = list;
  byId = new Map(list.map((p) => [String(p.id), p]));
  attachVisuals();
}

const VISUAL_PER_PRODUCT = 3;
const visualUrls = (list) => list.flatMap((p) => (p.images || []).slice(0, VISUAL_PER_PRODUCT));

function attachVisuals() {
  for (const p of products) {
    // ürünün ilk 3 fotoğrafı da görsel hafızaya alınır (farklı pozlar); p.visual ana görselin tanımı
    p.visuals = (p.images || []).slice(0, VISUAL_PER_PRODUCT).map((u) => getVisual(u)).filter(Boolean);
    p.visual = p.images[0] ? getVisual(p.images[0]) || p.visuals[0] || null : null;
    p.visualText = [...new Set(p.visuals.map((v) => v.text))].join(' ') || p.visual?.text || '';
  }
}

// Siteden gelen düz ürünleri bellekteki ürün biçimine çevirir (renk bazında, bedenleri içinde)
export function fromSite(list) {
  const items = list.map((p) => ({
    id: String(p.id),
    groupId: null,
    groupKey: null,
    descSig: asciiTokens(p.description).join('').slice(0, 160),
    colorField: p.colorField || '',
    modelName: '',
    modelKey: '',
    title: p.title,
    brand: '',
    category: cleanCategory(p.category || ''),
    color: p.colorField || '',
    description: p.description || '',
    price: p.price,
    priceOriginal: null,
    currency: 'TL',
    url: p.url,
    sizeParam: 'attribute_pa_numara',
    images: p.images || [],
    sizes: (p.sizes || []).map((x) => ({ size: String(x.size), stock: x.stock ?? null, inStock: x.inStock !== false })),
    inStock: p.inStock !== false,
    visual: null,
    visuals: [],
    visualText: '',
  }));
  for (const p of items) p.sizes.sort((a, b) => sizeNum(a.size) - sizeNum(b.size));
  assignModels(items);
  return items.filter((p) => p.title && p.price);
}

let lastSource = '';
let retryTimer = null;
let inflight = null;
let attempts = []; // son denemelerin kaydı (debug/status için)
let lastEnsure = 0;
let pushed = { at: 0, hash: '', count: 0 };
let lastJsonAt = 0; // WooCommerce'ten canlı (JSON) veri gelen son an; varken XML push'ları yok sayılır
let waiters = [];
const wake = () => { const w = waiters; waiters = []; w.forEach((r) => r()); };
let lastContact = Date.now(); // WordPress'in bota en son ulaştığı an (state sorgusu veya push)
let alertState = { okSent: false, lastFailAlert: 0 };

export const BOT_VERSION = '4.5-cok-fotograf-hafiza';

const note = (kaynak, ok, detay) => {
  attempts.unshift({ zaman: new Date().toISOString(), kaynak, ok, detay: redact(detay).slice(0, 400) });
  attempts = attempts.slice(0, 12);
};

async function alert(text) {
  if (!cfg.tgToken || !cfg.tgChatId) return;
  try {
    await sendTelegram(text);
  } catch (e) {
    console.error('[catalog] Telegram uyarısı gönderilemedi:', e.message);
  }
}

async function loadFromXml() {
  const { text } = await httpGet(cfg.feedUrl, { accept: 'application/xml,text/xml,*/*' });
  const list = parseFeed(text);
  if (!list.length) throw new Error('Feed indirildi ama ürün bulunamadı (alan adlarını kontrol edin)');
  return list;
}

// Canlı kaynaklar çalışmazsa data/feed.xml (elle yüklenen kopya) okunur
async function loadFromFile() {
  const file = path.resolve(cfg.fallbackFile || 'data/feed.xml');
  const text = await fs.readFile(file, 'utf8');
  const list = parseFeed(text);
  if (!list.length) throw new Error(`${file} içinde ürün bulunamadı`);
  return list;
}

const isPushMode = () => cfg.catalogSource === 'push' || (cfg.catalogSource === 'auto' && Boolean(cfg.pushKey));

async function persistPush(xml, meta) {
  try {
    const file = path.resolve(cfg.storeFile);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, xml);
    await fs.rename(`${file}.tmp`, file);
    await fs.writeFile(`${file}.json`, JSON.stringify(meta));
  } catch (e) {
    console.error('[catalog] son push verisi diske yazılamadı:', e.message);
  }
}

// Push modu: canlı siteye gitmez. Bellekte veri varsa dokunmaz; yoksa diskteki SON WordPress verisini yükler.
async function loadStored() {
  const file = path.resolve(cfg.storeFile);
  const raw = await fs.readFile(file, 'utf8');
  const isJson = /^\s*[\[{]/.test(raw);
  const list = isJson ? fromSite(JSON.parse(raw)) : parseFeed(raw);
  if (!list.length) throw new Error('kayıtlı veri boş');
  let meta = {};
  try {
    meta = JSON.parse(await fs.readFile(`${file}.json`, 'utf8'));
  } catch {
    /* meta yoksa sorun değil */
  }
  return { list, meta };
}

async function doPushRefresh() {
  if (products.length) return;
  try {
    const { list, meta } = await loadStored();
    setProductsInternal(list);
    lastUpdated = new Date();
    lastSource = 'son WordPress verisi (diskten)';
    lastError = null;
    pushed = { at: meta.at || 0, hash: meta.hash || '', count: list.length };
    if (meta.format === 'json') lastJsonAt = meta.at || Date.now();
    wake();
    note('disk', true, `${list.length} ürün`);
    console.log(`[catalog] diskten son WordPress verisi yüklendi: ${list.length} renk/ürün`);
    if (!alertState.okSent) {
      alertState.okSent = true;
      alert(`✅ Katalog son WordPress verisiyle yüklendi (${BOT_VERSION})\n${list.length} renk/ürün, ${new Set(list.map((p) => p.modelKey)).size} model.\nBot, WordPress'ten yeni veri gelene kadar bu stoklarla devam eder.`);
    }
    indexVisuals(visualUrls(list))
      .then((n) => n && attachVisuals())
      .catch((e) => console.error('[visual]', e.message));
    return;
  } catch (e) {
    note('disk', false, e.code === 'ENOENT' ? 'kayıtlı WordPress verisi yok' : e.message);
  }
  try {
    const list = await loadFromFile();
    setProductsInternal(list);
    lastUpdated = new Date();
    lastSource = 'dosya (data/feed.xml)';
    note('dosya', true, `${list.length} ürün`);
    wake();
    return;
  } catch {
    /* dosya yok */
  }
  lastError = "Henüz WordPress'ten ürün verisi gelmedi (kod parçacığı etkin mi? ?cb_push=1 adresi HTTP 200 veriyor mu?)";
  if (Date.now() - alertState.lastFailAlert > 3 * 3600 * 1000) {
    alertState.lastFailAlert = Date.now();
    alert(`⚠️ Katalog boş (${BOT_VERSION}). WordPress'ten henüz ürün verisi gelmedi.\n${lastError}`);
  }
}

async function doRefresh() {
  if (isPushMode()) return doPushRefresh();
  const mode = cfg.catalogSource; // auto | xml | site
  const errors = [];
  let list = null;
  let source = '';

  if (mode !== 'site' && cfg.feedUrl) {
    try {
      list = await loadFromXml();
      source = 'xml';
      note('xml', true, `${list.length} ürün`);
    } catch (e) {
      errors.push(`XML: ${e.message}`);
      note('xml', false, e.message);
      console.error('[catalog] XML okunamadı:', e.message);
    }
  }
  if (!list && mode !== 'xml') {
    try {
      const r = await fetchSiteProducts();
      list = fromSite(r.list);
      source = `site (${r.how})`;
      lastItemCount = r.list.length;
      lastRawSample = [];
      if (!list.length) throw new Error('Siteden ürün okunamadı');
      note('site', true, `${list.length} ürün (${r.how})`);
    } catch (e) {
      list = null;
      errors.push(`Site: ${e.message}`);
      note('site', false, e.message);
      console.error('[catalog] siteden okunamadı:', e.message);
    }
  }
  const pushFresh = pushed.at && Date.now() - pushed.at < 6 * 3600 * 1000 && products.length > 0;
  if (!list && !pushFresh) {
    try {
      list = await loadFromFile();
      source = 'dosya (data/feed.xml, stok güncel olmayabilir)';
      note('dosya', true, `${list.length} ürün`);
    } catch (e) {
      list = null;
      if (e.code !== 'ENOENT') errors.push(`Dosya: ${e.message}`);
      note('dosya', false, e.code === 'ENOENT' ? 'data/feed.xml yok' : e.message);
    }
  }

  if (!list) {
    lastError = redact(errors.join(' | ')) || 'Katalog kaynağı tanımlı değil';
    if (!products.length && !retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        refreshCatalog();
      }, 5 * 60 * 1000);
      retryTimer.unref?.();
    }
    if (!pushFresh && Date.now() - alertState.lastFailAlert > 3 * 3600 * 1000) {
      alertState.lastFailAlert = Date.now();
      alertState.okSent = false;
      alert(`⚠️ KATALOG YÜKLENEMEDİ (${BOT_VERSION})\nBot şu an ürün/stok bilgisi veremiyor${products.length ? ' (eski veri kullanılıyor)' : ''}.\n\n${lastError}\n\nÇözüm: data/feed.xml dosyasını GitHub'a yükleyin veya sitenizde Render IP'lerine izin verin.`);
    }
    return;
  }

  setProductsInternal(list);
  lastUpdated = new Date();
  lastError = errors.length ? `(yedek kaynak kullanıldı) ${errors.join(' | ')}` : null;
  lastSource = source;
  console.log(
    `[catalog] kaynak: ${source} | ${lastItemCount} kayıt -> ${list.length} renk/ürün, ${new Set(list.map((p) => p.modelKey)).size} model (${list.filter((p) => p.inStock).length} stokta)`
  );
  if (!alertState.okSent) {
    alertState.okSent = true;
    alert(`✅ Katalog yüklendi (${BOT_VERSION})\nKaynak: ${source}\n${list.length} renk/ürün, ${new Set(list.map((p) => p.modelKey)).size} model, ${list.filter((p) => p.inStock).length} stokta.${errors.length ? `\nNot: ${errors.join(' | ').slice(0, 500)}` : ''}`);
  }
  indexVisuals(visualUrls(list))
    .then((n) => n && attachVisuals())
    .catch((e) => console.error('[visual]', e.message));
}

// Aynı anda tek yenileme çalışır; diğer çağıranlar aynı sonucu bekler
export function refreshCatalog() {
  if (!inflight) {
    inflight = doRefresh()
      .catch((e) => {
        lastError = e.message;
        console.error('[catalog] yenileme hatası:', e);
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

// WordPress'in gönderdiği XML'i yükler (Cloudflare'i aşmak için sunucu -> bot yönünde aktarım)
export function pushFeed(xml, hash = '') {
  if (lastJsonAt && Date.now() - lastJsonAt < 24 * 3600 * 1000) return { ignored: true, count: products.length, note: 'WooCommerce canlı verisi aktif; XML gönderimi yok sayıldı. Eski XML kod parçacığını kapatın.' };
  const list = parseFeed(xml);
  if (!list.length) throw new Error('Gönderilen XML içinde ürün bulunamadı');
  setProductsInternal(list);
  lastUpdated = new Date();
  lastSource = 'push (WordPress)';
  lastError = null;
  pushed = { at: Date.now(), hash, count: list.length };
  lastContact = Date.now();
  persistPush(xml, { at: pushed.at, hash, format: 'xml' });
  wake();
  console.log(`[catalog] push: ${list.length} renk/ürün, ${new Set(list.map((p) => p.modelKey)).size} model (${list.filter((p) => p.inStock).length} stokta)`);
  if (!alertState.okSent) {
    alertState.okSent = true;
    alert(`✅ Katalog yüklendi (${BOT_VERSION})\nKaynak: WordPress push\n${list.length} renk/ürün, ${new Set(list.map((p) => p.modelKey)).size} model, ${list.filter((p) => p.inStock).length} stokta.`);
  }
  indexVisuals(visualUrls(list))
    .then((n) => n && attachVisuals())
    .catch((e) => console.error('[visual]', e.message));
  return { count: list.length, models: new Set(list.map((p) => p.modelKey)).size };
}

// WooCommerce'ten (veritabanından) canlı gönderilen ürün listesi (JSON). XML'e bağlı değildir.
export function pushJson(text, hash = '') {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error('Geçersiz JSON');
  }
  if (!Array.isArray(arr)) throw new Error('Ürün listesi dizi olmalı');
  const list = fromSite(arr);
  if (!list.length) throw new Error('Gönderilen listede geçerli ürün yok');
  setProductsInternal(list);
  lastUpdated = new Date();
  lastSource = 'push (WooCommerce canlı)';
  lastError = null;
  lastItemCount = arr.length;
  pushed = { at: Date.now(), hash, count: list.length };
  lastJsonAt = pushed.at;
  lastContact = pushed.at;
  persistPush(text, { at: pushed.at, hash, format: 'json' });
  wake();
  console.log(`[catalog] woo push: ${arr.length} ürün -> ${list.length} renk/ürün, ${new Set(list.map((p) => p.modelKey)).size} model (${list.filter((p) => p.inStock).length} stokta)`);
  if (!alertState.okSent) {
    alertState.okSent = true;
    alert(`✅ Katalog yüklendi (${BOT_VERSION})\nKaynak: WooCommerce canlı veri\n${list.length} renk/ürün, ${new Set(list.map((p) => p.modelKey)).size} model, ${list.filter((p) => p.inStock).length} stokta.`);
  }
  indexVisuals(visualUrls(list))
    .then((n) => n && attachVisuals())
    .catch((e) => console.error('[visual]', e.message));
  return { count: list.length, models: new Set(list.map((p) => p.modelKey)).size };
}

// WordPress her sorguladığında 'hayattayım' sinyali sayılır
export const pushState = () => {
  lastContact = Date.now();
  return { hash: pushed.hash, count: pushed.count, at: pushed.at };
};

export const isEmpty = () => products.length === 0;

// Katalog boşsa (ör. uyku/yeniden başlatma sonrası) önce diskten dener; yoksa WordPress'ten gelecek veriyi BEKLER,
// böylece bot eksik bilgiyle cevap vermez. Push modunda en fazla CATALOG_WAIT_MIN dakika, değilse 20 sn bekler.
export async function ensureLoaded() {
  if (products.length) return true;
  if (!inflight && Date.now() - lastEnsure > 60 * 1000) {
    lastEnsure = Date.now();
    refreshCatalog();
  }
  if (inflight) await Promise.race([inflight, new Promise((r) => setTimeout(r, 20000))]);
  if (products.length) return true;
  if (isPushMode()) {
    const ms = Math.max(0, cfg.catalogWaitMin) * 60 * 1000;
    console.log(`[catalog] katalog boş, WordPress'ten veri bekleniyor (en fazla ${cfg.catalogWaitMin} dk)`);
    await new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
      waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
  return products.length > 0;
}

export function debugStatus() {
  return {
    version: BOT_VERSION,
    catalog: catalogStatus(),
    attempts,
    config: {
      catalogSource: cfg.catalogSource,
      feedHost: (() => { try { return new URL(cfg.feedUrl).host; } catch { return cfg.feedUrl ? 'GEÇERSİZ (https:// ile başlamıyor)' : 'TANIMSIZ'; } })(),
      siteCatalogUrl: cfg.siteCatalogUrl || 'TANIMSIZ',
      fallbackFile: cfg.fallbackFile,
      pushModu: isPushMode(),
      canliWoo: Boolean(lastJsonAt),
      storeFile: cfg.storeFile,
      wordpressSonTemas: new Date(lastContact).toISOString(),
      telegramAyarli: Boolean(cfg.tgToken && cfg.tgChatId),
    },
  };
}

// WordPress uzun süre bota ulaşmazsa ekibi uyarır. Bot satışa SON BİLİNEN verilerle devam eder.
let lastStaleAlert = 0;
export function checkStale() {
  if (!products.length || !isPushMode()) return false;
  const hours = (Date.now() - lastContact) / 3600000;
  if (hours > 6 && Date.now() - lastStaleAlert > 6 * 3600000) {
    lastStaleAlert = Date.now();
    alert(`⚠️ WordPress'ten ${Math.floor(hours)} saattir haber alınamadı. Bot son bilinen stoklarla satışa devam ediyor.\nKontrol: WPCode'daki kod parçacığı etkin mi, anahtar Render'daki CATALOG_PUSH_KEY ile aynı mı, ?cb_push=1 adresi HTTP 200 veriyor mu?`);
    return true;
  }
  return false;
}

export function startCatalogRefresh() {
  setInterval(checkStale, 30 * 60 * 1000).unref?.();
  refreshCatalog();
  setInterval(refreshCatalog, cfg.feedRefreshMin * 60 * 1000).unref?.();
}

export function catalogStatus() {
  return { source: lastSource, count: products.length, models: new Set(products.map((p) => p.modelKey)).size, visualIndexed: visualCount(), lastUpdated, lastError };
}

// Test amaçlı: listeyi doğrudan yükle
export function setProducts(list) {
  products = list;
  byId = new Map(list.map((p) => [String(p.id), p]));
}

export const allProducts = () => products;

// ---------- sorgular ----------
export function hasSize(p, size) {
  if (!size) return true;
  if (!p.sizes.length) return p.inStock;
  const k = sizeKey(size);
  return p.sizes.some((s) => s.inStock && sizeKey(s.size) === k);
}

export function getProduct(id) {
  return byId.get(String(id)) || null;
}

// "botlar" -> "bot" gibi basit çekim eki temizliği
const stem = (t) => (t.length > 4 ? t.replace(/(lar|ler)(i|in|e|a|den|dan)?$/, '') : t);

export function searchProducts({ query = '', size, maxPrice, limit = 8, excludeIds = [], inStockOnly = true } = {}) {
  const tokens = [...new Set(asciiTokens(query).filter((t) => t.length > 1).flatMap((t) => [t, stem(t)]))];
  const ex = new Set(excludeIds.map(String));
  const scored = [];
  for (const p of products) {
    if (ex.has(String(p.id))) continue;
    if (inStockOnly && !p.inStock) continue;
    if (size && !hasSize(p, size)) continue;
    if (maxPrice && p.price > maxPrice) continue;
    let score = 0;
    if (tokens.length) {
      const hay = norm([p.title, p.modelName, p.brand, p.category, p.color, p.visualText, p.description].join(' '));
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

// Aynı modelin diğer renkleri; size verilirse sadece o numarası stokta olanlar
export function otherColors(p, size) {
  return products.filter((x) => x.id !== p.id && x.modelKey === p.modelKey && x.inStock && hasSize(x, size));
}

// Aynı modelin tüm renkleri (stok durumu bilgisiyle)
export function familyOf(p) {
  return products.filter((x) => x.modelKey === p.modelKey);
}

// Her modelden önce tek renk, sonra kalanlar: öneri listesi çeşitli olsun
function diversify(list, limit) {
  const seen = new Set();
  const first = [];
  const rest = [];
  for (const x of list) {
    if (seen.has(x.modelKey)) rest.push(x);
    else {
      seen.add(x.modelKey);
      first.push(x);
    }
  }
  return [...first, ...rest].slice(0, limit);
}

const styleSet = (p) =>
  new Set(
    asciiTokens([p.category, p.visual?.tur, p.visual?.stil, p.visual?.taban, p.visual?.materyal, p.visual?.desen, p.visual?.logo].filter(Boolean).join(' ')).filter((t) => t.length > 2)
  );

// Benzerlik: kategori + görsel hafızadaki tür/stil/taban/materyal/desen örtüşmesi + fiyat yakınlığı
export function similarProducts(p, size, limit = 6) {
  const sa = styleSet(p);
  const scored = [];
  for (const x of products) {
    if (x.id === p.id || x.modelKey === p.modelKey || !x.inStock || !hasSize(x, size)) continue;
    const sb = styleSet(x);
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    const union = sa.size + sb.size - inter || 1;
    let score = (inter / union) * 6;
    if (p.category && x.category && norm(x.category) === norm(p.category)) score += 3;
    if (p.brand && x.brand && norm(x.brand) === norm(p.brand)) score += 1;
    if (p.price && Math.abs(x.price - p.price) / p.price <= 0.3) score += 1;
    if (asciiTokens(p.color).some((t) => asciiTokens(x.color).includes(t))) score += 0.5;
    scored.push({ x, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return diversify(scored.map((s) => s.x), limit);
}

// Çapraz satış: müşterinin numarası stokta olan, farklı modellerden öneriler
export function suggestForSize(size, excludeIds = [], count = 8, preferCategory = '') {
  const excluded = new Set(excludeIds.map(String));
  const excludedModels = new Set(products.filter((p) => excluded.has(String(p.id))).map((p) => p.modelKey));
  const pool = searchProducts({ size, excludeIds, limit: 500 });
  const pc = norm(preferCategory);
  const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  const same = pc ? pool.filter((p) => norm(p.category).includes(pc)) : [];
  const ordered = [...shuffle(same), ...shuffle(pool.filter((p) => !same.includes(p)))];
  const newModels = ordered.filter((p) => !excludedModels.has(p.modelKey));
  const sameModels = ordered.filter((p) => excludedModels.has(p.modelKey));
  // önce yeni modeller (her modelden tek renk), sonra yeni modellerin diğer renkleri, en son siparişteki modelin diğer renkleri
  return [...diversify(newModels, 500), ...sameModels].slice(0, count);
}

// Müşteri fotoğrafının tanımını (tür, renk, stil, taban, materyal, desen) görsel hafızadaki ürün tanımlarıyla karşılaştırıp
// görsel karşılaştırmaya girecek aday ürünleri daraltır. En iyi birkaç modelin diğer renkleri de aday listesine eklenir.
export function shortlistByVisual(desc, hint = '', limit = 14) {
  const toks = (k) => new Set(asciiTokens(desc?.[k] || '').filter((t) => t.length > 2));
  const [tur, renk, stil, taban, mat, desen, logo] = ['tur', 'renk', 'stil', 'taban', 'materyal', 'desen', 'logo'].map(toks);
  const hintTok = new Set(asciiTokens(hint).filter((t) => t.length > 2));
  const scored = products
    .filter((p) => p.images.length)
    .map((p) => {
      let s = 0;
      const ov = (set, text, w) => {
        for (const t of asciiTokens(text)) if (set.has(t)) s += w;
      };
      const vs = p.visuals?.length ? p.visuals : p.visual ? [p.visual] : [];
      if (vs.length) {
        let best = 0;
        const base = s;
        for (const v of vs) {
          s = base;
          ov(tur, v.tur, 3);
          ov(renk, v.renk, 2);
          ov(stil, v.stil, 2);
          ov(taban, v.taban, 1);
          ov(mat, v.materyal, 1);
          ov(desen, v.desen, 1);
          ov(logo, v.logo, 3); // marka/logo en ayırt edici ipucu
          best = Math.max(best, s - base);
        }
        s = base + best; // farklı pozlardan en iyi eşleşen fotoğraf sayılır
      } else {
        ov(tur, `${p.title} ${p.category}`, 2); // görsel tanımı henüz yoksa başlık/kategoriye bak
        ov(renk, p.color, 2);
      }
      ov(hintTok, `${p.title} ${p.modelName} ${p.color}`, 4);
      return { p, s };
    })
    .sort((a, b) => b.s - a.s);

  const out = [];
  const add = (p) => {
    if (out.length < limit && !out.includes(p)) out.push(p);
  };
  scored.slice(0, 3).forEach(({ p }) => {
    add(p);
    familyOf(p).forEach(add); // aynı modelin renkleri: tam rengi görsel karşılaştırma seçsin
  });
  scored.forEach(({ p }) => add(p));
  return out;
}

// Açıklamadaki kalıp/numara notlarını ayıklar ("kalıbı dardır, bir numara büyük alın" gibi)
export function fitNote(desc) {
  if (!desc) return '';
  const parts = String(desc).split(/(?<=[.!?])\s+|\n+|\s[-•|]\s/u);
  const hits = parts.filter((x) => /kal[ıi]p|numara|beden|\bdar\b|dardır|geniş|b[üu]y[üu]k al|k[üu][çc][üu]k al/i.test(x));
  return hits.join(' ').slice(0, 300);
}

// Bir modelin (tüm renkleri) stokta olan numaraları, küçükten büyüğe
export function modelSizes(p) {
  const set = new Set();
  for (const x of products) if (x.modelKey === p.modelKey && x.inStock) for (const sz of x.sizes) if (sz.inStock) set.add(String(sz.size));
  return [...set].sort((a, b) => parseFloat(a) - parseFloat(b));
}

// Model'e gidecek kısa ürün özeti (token tasarrufu için sade tutulur)
export function brief(p, size) {
  const out = {
    id: p.id,
    baslik: p.title,
    fiyat_tl: p.price,
    stokta_olan_bedenler: p.sizes.filter((s) => s.inStock).map((s) => s.size),
  };
  if (p.modelName) out.model = p.modelName;
  if (size) out.secilen_beden_stokta = hasSize(p, size);
  if (p.visual?.ozet) out.gorunum = p.visual.ozet.slice(0, 100);
  if (p.description) out.aciklama = p.description.slice(0, 140);
  out.kalip_notu = fitNote(p.description) || 'özel kalıp notu yok (standart/tam kalıp)';
  return out;
}

// ---------- teşhis (debug) ----------
const clip = (_k, v) => (typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…' : v);

export function debugFeed() {
  return {
    kaynak: lastSource,
    okunan_kayit: lastItemCount,
    islenen_urun_renk_bazinda: products.length,
    model_sayisi: new Set(products.map((p) => p.modelKey)).size,
    gorsel_tanimli: products.filter((p) => p.visual).length,
    son_hata: lastError,
    ham_ornek_kayitlar: JSON.parse(JSON.stringify(lastRawSample, clip)),
  };
}

const sizeLine = (p) => p.sizes.map((x) => `${x.size}${x.inStock ? '✓' : '✗'}${x.stock != null ? '(' + x.stock + ')' : ''}`).join(' ');

export function debugSearch(q = '', limit = 10) {
  const list = q ? searchProducts({ query: q, limit, inStockOnly: false }) : products.slice(0, limit);
  return {
    toplam_urun: products.length,
    sonuc: list.map((p) => ({
      id: p.id,
      baslik: p.title,
      model: p.modelName,
      renk: p.color,
      model_anahtari: p.modelKey,
      kategori: p.category,
      fiyat: p.price,
      eski_fiyat: p.priceOriginal,
      stokta: p.inStock,
      bedenler: sizeLine(p),
      gorsel_tanimi: p.visual?.ozet || null,
      ilk_gorsel: p.images[0] || null,
      link: p.url,
    })),
  };
}

// Modeller, renkleri ve her modele en benzeyen diğer modeller
export function debugFamilies() {
  const models = new Map();
  for (const p of products) {
    if (!models.has(p.modelKey)) models.set(p.modelKey, []);
    models.get(p.modelKey).push(p);
  }
  return [...models.entries()].map(([key, list]) => ({
    model: list[0].modelName,
    model_anahtari: key,
    kategori: list[0].category,
    renkler: list.map((p) => ({ renk: p.color, id: p.id, bedenler: sizeLine(p), fiyat: p.price })),
    benzer_modeller: [...new Set(similarProducts(list[0], '', 6).map((s) => s.modelName))].slice(0, 4),
  }));
}
