// Kaynak seçimi (XML -> site), WooCommerce Store API / HTML okuma, numara stoğu ve görsel hafıza aday daraltmasını test eder.
// Ağ çağrıları sahte (fetch taklit edilir). Çalıştırma: npm run test:site
import { cfg } from './src/config.js';
import { refreshCatalog, catalogStatus, allProducts, hasSize, otherColors, brief, fromSite, shortlistByVisual, searchProducts } from './src/catalog.js';
import { mapStoreProduct } from './src/siteCatalog.js';
import { parseProductPage } from './src/scrape.js';

let fail = 0;
const ok = (c, m) => {
  console.log(c ? 'OK  ' : 'FAIL', m);
  if (!c) fail++;
};

// ---------- sahte site ----------
const SITE = 'https://magaza.com';
const esc = (o) => JSON.stringify(o).replace(/"/g, '&quot;');
const DESC = {
  Lifestyle: 'Günlük kullanıma uygun, deri ve süet detaylı kadın sneaker. Yumuşak tekstil astar ve hafif taban ile gün boyu konfor sağlar. Numara aralığı 35 - 41.',
  Elevate: 'Yüksek taban detaylı, rahat kalıplı kadın spor ayakkabı. Hafif ve esnek taban yapısıyla günlük kullanım için tasarlandı. Numara aralığı 35 - 41.',
  Roven: 'Retro tasarımlı, nubuk ve file detaylı unisex sneaker. Esnek EVA taban ile uzun yürüyüşlerde rahatlık sunar. Numara aralığı 36 - 45.',
  '1906A': 'Premium dokulu, kalın tabanlı koşu stili sneaker. Nefes alan file yüzey ve darbe emici taban. Numara aralığı 36 - 45.',
};
const defs = [
  ['Lifestyle Leopar', 'Lifestyle', 11, 'Sneaker', 119900, 189900, [35, 36, 37, 38, 39, 40, 41], [37]],
  ['Lifestyle Siyah', 'Lifestyle', 12, 'Sneaker', 119900, 189900, [35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45], []],
  ['Elevate Beyaz Gri', 'Elevate', 13, 'Sneaker', 119900, 229900, [36, 37, 38, 39, 40, 41], []],
  ['Elevate Beyaz Lacivert', 'Elevate', 14, 'Sneaker', 119900, 229900, [36, 37, 38, 39, 40, 41], [38]],
  ['Elevate Siyah Beyaz', 'Elevate', 15, 'Sneaker', 119900, 229900, [36, 37, 38, 39, 40, 41], []],
  ['Roven Kahve Bej', 'Roven', 16, 'Sneaker', 119900, 229900, [37, 38, 39, 40, 41, 42], []],
  ['Roven Bej', 'Roven', 17, 'Sneaker', 119900, 229900, [37, 38, 39, 40, 41, 42], []],
  ['1906A Premium Haki', '1906A', 18, 'Sneaker', 159900, 229900, [37, 38, 39, 40], []],
  ['1906A Premium Gri Turuncu', '1906A', 19, 'Sneaker', 159900, 229900, [37, 38, 39, 40], []],
];
const slug = (t) => t.toLowerCase().replace(/ı/g, 'i').replace(/ü/g, 'u').replace(/[^a-z0-9]+/g, '-');
const storeJson = defs.map(([name, m, id, cat, price, reg, sizes]) => ({
  id,
  name,
  permalink: `${SITE}/product/${slug(name)}/`,
  type: 'variable',
  is_in_stock: true,
  prices: { price: String(price), regular_price: String(reg), sale_price: String(price), currency_minor_unit: 2 },
  images: [{ src: `${SITE}/wp-content/uploads/${id}.webp` }],
  categories: [{ name: cat }, { name: 'Tüm Ürünler' }],
  attributes: [{ name: 'Numara', terms: sizes.map((s) => ({ name: String(s) })) }],
  variations: sizes.map((s) => ({ id: id * 100 + s, attributes: [{ name: 'Numara', value: String(s) }] })),
  short_description: `<p>${DESC[m]}</p>`,
  description: '',
}));
const productHtml = ([name, m, id, , price, , sizes, outSizes]) => `<html><head><meta property="og:image" content="${SITE}/wp-content/uploads/${id}.webp"/></head><body>
<h1 class="product_title entry-title">${name}</h1><p class="price"><del>₺2.299</del> <ins><span class="woocommerce-Price-amount"><bdi>${(price / 100).toLocaleString('tr-TR')}₺</bdi></span></ins></p>
<form class="variations_form cart" data-product_id="${id}" data-product_variations="${esc(
  sizes.map((s) => ({ attributes: { attribute_pa_numara: String(s) }, display_price: price / 100, is_in_stock: !outSizes.includes(s), is_purchasable: true, max_qty: outSizes.includes(s) ? '' : 2 }))
)}"></form></body></html>`;
const categoryHtml = `<html><body>${defs.map((d) => `<li class="product"><a class="woocommerce-LoopProduct-link" href="${SITE}/product/${slug(d[0])}/">x</a></li>`).join('')}</body></html>`;
const feedXml = `<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel>
<item><g:id>1</g:id><g:title>Platform Taba</g:title><g:description>${DESC.Lifestyle}</g:description><g:availability>in stock</g:availability><g:price>2299.00 TRY</g:price><g:sale_price>1099.00 TRY</g:sale_price><g:link>${SITE}/product/platform-taba/?attribute_pa_numara=37</g:link><g:image_link>${SITE}/a.webp</g:image_link><g:item_group_id>10</g:item_group_id><product_type>Home &amp;gt; Bot</product_type></item>
</channel></rss>`;

let mode = 'xml-ok';
const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  const res = (status, body, type = 'text/html') => ({ ok: status < 400, status, headers: { get: () => type }, text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  if (u === cfg.feedUrl) return mode === 'xml-ok' ? res(200, feedXml, 'application/xml') : res(404, 'yok');
  if (u.includes('/wp-json/wc/store/v1/products')) return mode === 'store-api' ? res(200, JSON.stringify(storeJson), 'application/json') : res(404, 'yok');
  if (u === `${SITE}/product-category/tum-urunler/`) return res(200, categoryHtml);
  if (u.includes('/page/')) return res(404, 'yok');
  const d = defs.find((x) => u === `${SITE}/product/${slug(x[0])}/`);
  if (d) return res(200, productHtml(d));
  return res(404, 'yok');
};

cfg.feedUrl = `${SITE}/feed.xml`;
cfg.siteCatalogUrl = `${SITE}/product-category/tum-urunler/`;

// ---------- Store API eşlemesi ----------
const m0 = mapStoreProduct(storeJson[0]);
ok(m0.price === 1199, `Store API fiyatı kuruştan TL'ye çevrildi: ${m0.price}`);
ok(m0.sizes.length === 7 && m0.category === 'Sneaker', 'numara listesi ve kategori ("Tüm Ürünler" atlandı)');
ok(!('priceOriginal' in m0) || !m0.priceOriginal, 'üstü çizili fiyat tutulmuyor');

// ---------- ürün sayfasından numara stoğu ----------
const pg = parseProductPage(productHtml(defs[0]), `${SITE}/product/lifestyle-leopar/`);
ok(pg.sizes.length === 7 && pg.price === 1199, `ürün sayfası: 7 numara, fiyat ${pg.price}`);
ok(pg.sizes.find((s) => s.size === '37').inStock === false && pg.sizes.find((s) => s.size === '36').inStock === true, 'ürün sayfası: 37 tükenmiş, 36 var');

// ---------- model gruplama (gerçek sitedeki başlık biçimleri) ----------
const grouped = fromSite(storeJson.map(mapStoreProduct));
const names = [...new Set(grouped.map((p) => p.modelName))].sort();
ok(names.join('|') === '1906A Premium|Elevate|Lifestyle|Roven', `modeller: ${names.join(' | ')}`);
const colorsOf = (m) => grouped.filter((p) => p.modelName === m).map((p) => p.color).sort().join(', ');
ok(colorsOf('Elevate') === 'Beyaz Gri, Beyaz Lacivert, Siyah Beyaz', `Elevate renkleri: ${colorsOf('Elevate')} ("Beyaz" model adına karışmadı)`);
ok(colorsOf('Roven') === 'Bej, Kahve Bej' && colorsOf('1906A Premium') === 'Gri Turuncu, Haki', `Roven: ${colorsOf('Roven')} | 1906A Premium: ${colorsOf('1906A Premium')}`);

// ---------- kaynak seçimi ----------
cfg.catalogSource = 'auto';
mode = 'xml-ok';
await refreshCatalog();
ok(catalogStatus().source === 'xml' && allProducts().length === 1, `XML çalışıyorsa XML kullanılır (kaynak: ${catalogStatus().source})`);
ok(allProducts()[0].price === 1099 && allProducts()[0].category === 'Bot', 'XML: indirimli fiyat 1099, kategori temizlendi');

mode = 'store-api';
calls.length = 0;
await refreshCatalog();
const st = catalogStatus();
ok(st.source === 'site (store-api)' && allProducts().length === 9, `XML okunamayınca site (Store API) kullanıldı: ${st.source}, ${allProducts().length} ürün`);
ok(st.lastError && /yedek kaynak/.test(st.lastError), 'XML hatası kayda geçti');
const leopar = allProducts().find((p) => p.title === 'Lifestyle Leopar');
ok(leopar.price === 1199 && !hasSize(leopar, '37') && hasSize(leopar, '36'), 'numara stoğu ürün sayfasından geldi: Leopar 37 yok, 36 var');
ok(calls.some((c) => c.includes('/product/lifestyle-leopar/')), 'her ürünün sayfası okundu');
ok(otherColors(leopar, '37').some((p) => p.title === 'Lifestyle Siyah'), 'Leopar 37 yok -> Lifestyle Siyah 37 öneriliyor (diğer renk)');
ok(!('eski_fiyat_tl' in brief(leopar, '36')) && brief(leopar, '36').fiyat_tl === 1199, 'müşteriye giden özette üstü çizili fiyat yok');
ok(brief(leopar, '36').link === `${SITE}/product/lifestyle-leopar/?attribute_pa_numara=36`, 'ürün linki seçilen numarayla açılıyor');
ok(searchProducts({ query: 'sneaker', size: '45' }).every((p) => p.title === 'Lifestyle Siyah') && searchProducts({ query: 'sneaker', size: '45' }).length === 1, '45 numara sadece 35-45 aralığındaki üründe var');

mode = 'html';
await refreshCatalog();
ok(catalogStatus().source === 'site (html)' && allProducts().length === 9, `Store API de kapalıysa kategori sayfaları taranır: ${catalogStatus().source}, ${allProducts().length} ürün`);
const l2 = allProducts().find((p) => p.title === 'Lifestyle Leopar');
ok(l2 && !hasSize(l2, '37') && hasSize(l2, '36') && l2.price === 1199, 'HTML yolu: numara stoğu ve fiyat doğru');

cfg.catalogSource = 'xml';
mode = 'store-api';
calls.length = 0;
await refreshCatalog();
ok(!calls.some((c) => c.includes('/wp-json/')) && /XML/.test(catalogStatus().lastError || ''), 'CATALOG_SOURCE=xml iken siteye gidilmez');
cfg.catalogSource = 'auto';

// ---------- görsel hafıza ile aday daraltma ----------
await refreshCatalog(); // store-api
const all = allProducts();
const vis = (tur, renk, stil, taban) => ({ tur, renk, stil, taban, materyal: '', desen: '', ozet: '', text: `${tur} ${renk} ${stil} ${taban}` });
all.forEach((p) => (p.visual = vis('sneaker', 'beyaz', 'günlük', 'düz')));
const target = all.find((p) => p.title === 'Roven Bej');
target.visual = vis('retro sneaker', 'bej', 'retro file', 'kalın taban');
const sl = shortlistByVisual({ tur: 'sneaker', renk: 'bej', stil: 'retro', taban: 'kalın taban' }, '', 5);
ok(sl[0].title === 'Roven Bej', `müşteri fotoğrafının tanımına en yakın ürün listenin başında: ${sl[0].title}`);
ok(sl.some((p) => p.title === 'Roven Kahve Bej') && sl.length === 5, 'aynı modelin diğer rengi de aday listesinde (tam renk görsel karşılaştırmayla seçilsin)');

process.exit(fail ? 1 : 0);
