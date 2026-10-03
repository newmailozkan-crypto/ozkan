// Bot davranışı: katalog yedek dosyası, boş katalog koruması, Tazz Bej senaryoları (sahte Claude + sahte ağ).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cfg } from './src/config.js';
import { refreshCatalog, catalogStatus, isEmpty, setProducts, allProducts } from './src/catalog.js';

let fail = 0;
const ok = (c, m) => { console.log(c ? 'OK  ' : 'FAIL', m); if (!c) fail++; };

const SITE = 'https://magaza.com';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let mode = 'blocked';
const telegram = [];
const feed = (items) => `<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel>${items.join('')}</channel></rss>`;
const item = (id, grp, title, size, price = '1099.00', desc = 'Günlük kullanıma uygun rahat sneaker, yumuşak astar ve hafif taban. ') =>
  `<item><g:id>${id}</g:id><g:title>${title}</g:title><g:description>${desc}${grp}</g:description><g:availability>in stock</g:availability><g:price>2299.00 TRY</g:price><g:sale_price>${price} TRY</g:sale_price><g:link>${SITE}/product/${grp}/?attribute_pa_numara=${size}</g:link><g:image_link>${SITE}/img/${grp}.png</g:image_link><g:item_group_id>${grp}</g:item_group_id><product_type>Sneaker</product_type></item>`;
const sizesOf = (grp, title, sizes) => sizes.map((s, i) => item(`${grp}-${s}`, grp, title, s));
const FEED = feed([
  ...sizesOf('tazz-bej', 'Tazz Bej', [36, 37, 38]),
  ...sizesOf('tazz-siyah', 'Tazz Siyah', [36, 37, 38]),
  ...sizesOf('roven', 'Roven Kahve', [37, 38, 39]),
  ...sizesOf('elevate', 'Elevate Beyaz', [38, 39]),
]);

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const res = (status, body, type = 'text/html') => ({ ok: status < 400, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) }, text: async () => (typeof body === 'string' ? body : ''), arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.length) : new ArrayBuffer(0)), json: async () => ({ ok: true }) });
  if (u.startsWith('https://api.telegram.org')) { telegram.push(JSON.parse(opts.body).text); return res(200, '{}', 'application/json'); }
  if (u.includes('/img/')) return res(200, PNG, 'image/png');
  if (u === cfg.feedUrl) return mode === 'xml' ? res(200, FEED, 'application/xml') : res(403, '<html>Attention Required! | Cloudflare</html>');
  return res(403, 'Forbidden');
};

cfg.feedUrl = `${SITE}/feed.xml`;
cfg.siteCatalogUrl = `${SITE}/product-category/tum-urunler/`;
cfg.catalogSource = 'auto';
cfg.tgToken = 't'; cfg.tgChatId = '1';
cfg.fallbackFile = path.join(os.tmpdir(), `feed-${Date.now()}.xml`);

// ---------- 1) her şey engelli, dosya da yok ----------
await refreshCatalog();
ok(isEmpty(), 'her kaynak 403 verir, dosya yok -> katalog boş');
ok(/403/.test(catalogStatus().lastError || '') && /güvenlik duvarı/i.test(catalogStatus().lastError), 'hata nedeni (403 + güvenlik duvarı) kayıtlı');
ok(telegram.some((t) => t.includes('KATALOG YÜKLENEMEDİ') && /403/.test(t)), 'Telegram uyarısı gitti');

// ---------- 2) yedek dosya ----------
fs.writeFileSync(cfg.fallbackFile, FEED);
await refreshCatalog();
ok(!isEmpty() && /dosya/.test(catalogStatus().source), `yedek dosyadan yüklendi: ${catalogStatus().source}, ${allProducts().length} ürün`);
ok(telegram.some((t) => t.includes('Katalog yüklendi')), 'Telegram: katalog yüklendi bildirimi');
fs.unlinkSync(cfg.fallbackFile);

// ---------- 3) XML açılınca canlı kaynak kullanılır ----------
mode = 'xml';
await refreshCatalog();
ok(catalogStatus().source === 'xml', `XML erişilebilirken canlı XML: ${catalogStatus().source}`);
const bej = allProducts().find((p) => p.title === 'Tazz Bej');
ok(bej && bej.sizes.length === 3, 'Tazz Bej 36/37/38 okundu');

// ---------- sahte Claude ----------
const { handleDirectMessage } = await import('./src/ai.js');
let script = [];
let toolResults = [];
globalThis.__claudeStub = async (req) => {
  if (!req.system) {
    // görsel karşılaştırma: müşteri fotoğrafı = globalThis.__target
    const text = req.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const ids = [...text.matchAll(/Aday id=(\S+) \|/g)].map((m) => m[1]);
    const t = globalThis.__target;
    return { content: [{ type: 'text', text: JSON.stringify({ eslesmeler: ids.map((id) => ({ id, guven: id.startsWith(t.prefix) ? t.score : id.startsWith('tazz') ? 0.4 : 0.2, neden: '' })) }) }], stop_reason: 'end_turn' };
  }
  const last = req.messages[req.messages.length - 1];
  if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') toolResults.push(JSON.parse(last.content[0].content));
  const step = script.shift();
  if (!step) return { content: [{ type: 'text', text: 'tamam' }], stop_reason: 'end_turn' };
  return { content: [{ type: 'tool_use', id: `t${Math.random()}`, name: step.name, input: step.input }], stop_reason: 'tool_use' };
};
const run = async (userId, text, withImage = true) => {
  const sent = [];
  toolResults = [];
  const send = { text: async (t) => sent.push(['text', t]), image: async (u) => sent.push(['image', u]) };
  await handleDirectMessage({ userId, text, imageUrl: withImage ? `${SITE}/img/customer.png` : undefined, send });
  return { sent, images: sent.filter((s) => s[0] === 'image').length };
};
const firstTool = () => toolResults[0];

// A) Tazz Bej, 37 stokta -> fotoğraf otomatik
globalThis.__target = { prefix: 'tazz-bej', score: 0.9 };
script = [{ name: 'match_customer_image', input: { size: '37' } }];
let r = await run('u1', '37 numara var mı');
ok(firstTool().durum === 'stokta' && r.images === 1, `Tazz Bej 37 stokta, fotoğraf otomatik gitti (${firstTool().durum}, ${r.images} foto)`);

// B) güven 0.5 -> yine bulunur, teyit notu
globalThis.__target = { prefix: 'tazz-bej', score: 0.5 };
script = [{ name: 'match_customer_image', input: { size: '37' } }];
r = await run('u2', '37?');
ok(firstTool().durum === 'stokta' && /teyit/.test(firstTool().not), 'güven 0.5: ürün bulundu ve teyit istendi');

// C) 37 tükenmiş -> diğer renk
setProducts(allProducts().map((p) => (p.title === 'Tazz Bej' ? { ...p, sizes: p.sizes.map((s) => (s.size === '37' ? { ...s, inStock: false } : s)) } : p)));
globalThis.__target = { prefix: 'tazz-bej', score: 0.9 };
script = [{ name: 'match_customer_image', input: { size: '37' } }];
r = await run('u3', '37 numara', true);
ok(firstTool().durum === 'beden_yok_diger_renk_var' && r.images >= 1, `37 yok -> diğer renk fotoğrafı otomatik (${firstTool().durum}, ${r.images} foto)`);

// D) katalogda yok -> benzerler gönderilir
globalThis.__target = { prefix: 'zzz', score: 0.1 };
script = [{ name: 'match_customer_image', input: { size: '38' } }];
r = await run('u4', '38 numara');
ok(firstTool().durum === 'katalogda_yok' && r.images >= 1, `eşleşme yok -> benzer modeller gönderildi (${r.images} foto)`);

// E) show_models + tekrar engeli
script = [{ name: 'show_models', input: { size: '38', count: 5 } }, { name: 'show_models', input: { size: '38', count: 5 } }];
r = await run('u5', 'hangi modeller var', false);
ok(toolResults[0].adet >= 3 && r.images >= 3, `show_models fotoğrafları gönderdi (${r.images})`);
ok(toolResults[1].fotograflar_gonderildi.length === 0 && toolResults[1].zaten_gonderilmisti?.length >= 3, 'aynı fotoğraflar tekrar gönderilmedi');

// F) boş katalog koruması
setProducts([]);
mode = 'blocked';
script = [{ name: 'match_customer_image', input: { size: '37' } }];
globalThis.__target = { prefix: 'tazz-bej', score: 0.9 };
r = await run('u6', '37 numara var mı');
ok(firstTool().hata === 'KATALOG_BOS' && /DEME|yok/.test(firstTool().not) && r.images === 0, 'katalog boşken "yok" denmez, KATALOG_BOS notu döner');
ok(telegram.some((t) => t.includes('katalog BOŞ')), 'boş katalogda ekip Telegram ile uyarıldı');

console.log(fail ? `\n${fail} test BAŞARISIZ` : '\nTüm testler geçti');
process.exit(fail ? 1 : 0);
