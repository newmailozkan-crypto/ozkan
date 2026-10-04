// Push modu: canlı siteye gidilmez; son WordPress verisi diske yazılır, yeniden başlatmada geri yüklenir, WordPress susarsa son verilerle devam edilir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg } from './src/config.js';

let fail = 0;
const ok = (c, m) => { console.log(c ? 'OK  ' : 'FAIL', m); if (!c) fail++; };

const SITE = 'https://magaza.com';
const item = (grp, title, size) =>
  `<item><g:id>${grp}-${size}</g:id><g:title>${title}</g:title><g:description>Günlük rahat sneaker ${grp}</g:description><g:availability>in stock</g:availability><g:price>2299.00 TRY</g:price><g:sale_price>1099.00 TRY</g:sale_price><g:link>${SITE}/product/${grp}/?attribute_pa_numara=${size}</g:link><g:image_link>${SITE}/img/${grp}.png</g:image_link><g:item_group_id>${grp}</g:item_group_id><product_type>Sneaker</product_type></item>`;
const feed = (...its) => `<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel>${its.flat().join('')}</channel></rss>`;
const sz = (grp, title, sizes) => sizes.map((s) => item(grp, title, s));
const FEED1 = feed(sz('tazz-bej', 'Tazz Bej', [36, 37]), sz('roven', 'Roven Kahve', [37, 38]));
const FEED2 = feed(sz('tazz-bej', 'Tazz Bej', [36, 37])); // Roven satıştan kalktı

const telegram = [];
let liveCalls = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org')) { telegram.push(JSON.parse(opts.body).text); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  if (!u.includes('/img/')) liveCalls++; // site/XML'e gidilmemeli (görsel indirmeleri sayılmaz)
  return { ok: false, status: 403, headers: { get: () => null }, text: async () => 'Just a moment...' };
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
cfg.storeFile = path.join(dir, 'sub', 'last-push.xml');
cfg.fallbackFile = path.join(dir, 'yok.xml');
cfg.feedUrl = `${SITE}/feed.xml`;
cfg.siteCatalogUrl = `${SITE}/product-category/tum-urunler/`;
cfg.catalogSource = 'auto';
cfg.pushKey = 'k'.repeat(40);
cfg.tgToken = 't'; cfg.tgChatId = '1';

// ---------- 1) ilk açılış: veri yok, canlı siteye gidilmez ----------
const c1 = await import('./src/catalog.js?boot1');
await c1.refreshCatalog();
ok(c1.isEmpty() && liveCalls === 0, `veri yokken boş kalır, siteye/XML'e istek atılmaz (istek: ${liveCalls})`);
ok(telegram.some((t) => /WordPress'ten henüz ürün verisi gelmedi/.test(t)), 'Telegram: WordPress verisi bekleniyor uyarısı');

// ---------- 2) WordPress push ----------
c1.pushFeed(FEED1, 'h1');
await new Promise((r) => setTimeout(r, 200));
ok(c1.allProducts().length === 2 && fs.existsSync(cfg.storeFile) && fs.existsSync(`${cfg.storeFile}.json`), 'push yüklendi ve son veri diske yazıldı');

// ---------- 3) yeniden başlatma: Render uyandı, bellek sıfırlandı ----------
const c2 = await import('./src/catalog.js?boot2');
ok(c2.isEmpty(), 'yeni süreç boş başlar');
await c2.refreshCatalog();
ok(!c2.isEmpty() && c2.allProducts().length === 2 && /diskten/.test(c2.catalogStatus().source), `son WordPress verisi diskten geri yüklendi (${c2.catalogStatus().source})`);
ok(c2.pushState().hash === 'h1' && liveCalls === 0, 'WordPress hash\'i hatırlanır (gereksiz yeniden gönderim yok), siteye istek atılmadı');
ok(telegram.some((t) => /son WordPress verisiyle yüklendi/.test(t)), 'Telegram: son veriyle yüklendi bildirimi');

// ---------- 4) WordPress susarsa son verilerle satışa devam ----------
const real = Date.now; const t0 = real();
Date.now = () => t0 + 7 * 3600000;
const n0 = telegram.length;
ok(c2.checkStale() === true && telegram.slice(n0).some((t) => /saattir haber alınamadı.*devam ediyor/s.test(t)), '6+ saat temas yoksa Telegram uyarısı');
ok(c2.allProducts().length === 2 && !c2.isEmpty(), 'uyarıya rağmen katalog silinmez, bot son stoklarla devam eder');
await c2.refreshCatalog();
ok(c2.allProducts().length === 2, 'periyodik yenileme canlı siteye gitmeden mevcut veriyi korur');
c2.pushState(); // WordPress tekrar ulaştı
ok(c2.checkStale() === false, 'WordPress yeniden ulaşınca uyarı susar');
Date.now = real;

// ---------- 5) satıştan kalkan ürün bir sonraki push'ta düşer ----------
c2.pushFeed(FEED2, 'h2');
await new Promise((r) => setTimeout(r, 200));
ok(c2.allProducts().length === 1 && !c2.allProducts().some((p) => /Roven/.test(p.title)), 'satıştan kalkan ürün yeni push ile katalogdan çıktı');

// ---------- 6) disk yazılamasa bile push çalışır ----------
cfg.storeFile = path.join(dir, 'dosya.txt', 'x', 'last.xml');
fs.writeFileSync(path.join(dir, 'dosya.txt'), 'engel'); // klasör yerine dosya var -> yazma hatası
const r6 = c2.pushFeed(FEED1, 'h3');
await new Promise((r) => setTimeout(r, 200));
ok(r6.count === 2 && c2.allProducts().length === 2, 'disk yazma hatasında push yine de bellekteki kataloğu günceller');

// ---------- 7) WooCommerce canlı JSON ----------
{
  const cj = await import('./src/catalog.js?boot3');
  cfg.storeFile = path.join(dir, 'woo', 'last.dat');
  // PHP kod parçacığının (test-fixtures/woo-harness.php) ürettiği gerçek çıktı
  const json = fs.readFileSync(new URL('./test-fixtures/woo-list.json', import.meta.url), 'utf8');
  const r = cj.pushJson(json, 'w1');
  await new Promise((res) => setTimeout(res, 200));
  const tazz = cj.allProducts().find((p) => p.title === 'Tazz Bej');
  const roven = cj.allProducts().find((p) => p.title.startsWith('Roven'));
  ok(r.count === 2 && cj.catalogStatus().source === 'push (WooCommerce canlı)', `WooCommerce JSON yüklendi (${cj.catalogStatus().source})`);
  ok(tazz && cj.hasSize(tazz, '37') && !cj.hasSize(tazz, '38') && !cj.hasSize(tazz, '39'), 'Tazz Bej: 37 stokta, 38 tükenmiş, yayında olmayan 39 yok');
  ok(roven && !roven.inStock && !cj.hasSize(roven, '37'), 'tüm numaraları biten ürün stokta görünmüyor');
  ok(tazz.price === 1199 && tazz.images.length === 2, 'fiyat ve görseller aktarıldı');
  const x = cj.pushFeed(FEED1, 'xml');
  ok(x.ignored === true && cj.allProducts().length === 2, 'canlı veri varken eski XML gönderimi yok sayılır');
  const cj2 = await import('./src/catalog.js?boot4');
  await cj2.refreshCatalog();
  ok(cj2.allProducts().length === 2 && cj2.pushState().hash === 'w1' && cj2.pushFeed(FEED1, 'x').ignored === true, 'yeniden başlatmada JSON verisi diskten geri yüklendi, canlı kaynak önceliği korundu');
  let threw = false;
  try { cj.pushJson('{bozuk', 'z'); } catch { threw = true; }
  ok(threw && cj.allProducts().length === 2, 'bozuk JSON mevcut kataloğu bozmaz');
}

// ---------- 8) uyanma sonrası: mesaj, güncel veri gelene kadar BEKLER ----------
{
  cfg.storeFile = path.join(dir, 'yok-klasor', 'x.dat');
  const w = await import('./src/catalog.js?boot5');
  cfg.catalogWaitMin = 0.5;
  const t0 = Date.now();
  const waiting = w.ensureLoaded();
  setTimeout(() => w.pushJson(fs.readFileSync(new URL('./test-fixtures/woo-list.json', import.meta.url), 'utf8'), 'w2'), 300);
  const got = await waiting;
  ok(got === true && Date.now() - t0 < 5000 && !w.isEmpty(), `boş katalogda mesaj beklendi, WordPress verisi gelince devam edildi (${Date.now() - t0} ms)`);
  const w2 = await import('./src/catalog.js?boot6');
  cfg.storeFile = path.join(dir, 'yok-klasor2', 'x.dat');
  cfg.catalogWaitMin = 0.01;
  const t1 = Date.now();
  const got2 = await w2.ensureLoaded();
  ok(got2 === false && Date.now() - t1 < 3000 && w2.isEmpty(), 'süre dolarsa (veri hiç gelmezse) bekleme biter; bot ekibe yönlendirme akışına geçer');
}

console.log(fail ? `\n${fail} test BAŞARISIZ` : '\nTüm testler geçti');
process.exit(fail ? 1 : 0);
