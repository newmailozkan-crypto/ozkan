// Sipariş hafızası, iptal (3 saat), memnuniyet fotoğrafı, yorum hafızası (sahte Claude + sahte ağ)
import os from 'node:os';
import path from 'node:path';
process.env.CUSTOMERS_FILE = path.join(os.tmpdir(), `cust-${Date.now()}.json`);
process.env.ANTHROPIC_API_KEY = 'x';
const { cfg } = await import('./src/config.js');
cfg.tgToken = 't'; cfg.tgChatId = '1';
const { pushFeed, allProducts } = await import('./src/catalog.js');
const customers = await import('./src/customers.js');
const ai = await import('./src/ai.js');

let fail = 0;
const ok = (c, m) => { console.log(c ? 'OK  ' : 'FAIL', m); if (!c) fail++; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tg = [];
const photos = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const res = (body, type) => ({ ok: true, status: 200, headers: { get: () => type }, text: async () => '', json: async () => ({ ok: true }), arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) });
  if (u.includes('/sendPhoto')) { photos.push(opts.body.get('caption')); return res('', 'application/json'); }
  if (u.startsWith('https://api.telegram.org')) { tg.push(JSON.parse(opts.body).text); return res('{}', 'application/json'); }
  return res(PNG, 'image/png');
};
const item = (grp, title, size, price) => `<item><g:id>${grp}-${size}</g:id><g:title>${title}</g:title><g:description>Hafif taban. Kalıbı dardır, bir numara büyük alınız. ${grp}</g:description><g:availability>in stock</g:availability><g:price>2999.00 TRY</g:price><g:sale_price>${price} TRY</g:sale_price><g:link>https://m.com/product/${grp}/?attribute_pa_numara=${size}</g:link><g:image_link>https://m.com/img/${grp}.png</g:image_link><g:item_group_id>${grp}</g:item_group_id><product_type>Sneaker</product_type></item>`;
pushFeed(`<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel>${item('tazz-bej', 'Tazz Bej', 37, '1199.00')}${item('roven', 'Roven Kahve', 37, '1299.00')}</channel></rss>`, 'h1');
const [p1, p2] = allProducts();

let script = [];
let results = [];
let systems = [];
globalThis.__claudeStub = async (req) => {
  if (!req.system) return { content: [{ type: 'text', text: JSON.stringify({ eslesmeler: [] }) }], stop_reason: 'end_turn' };
  systems.push(req.system.map((b) => b.text).join('\n'));
  const first = req.messages[req.messages.length - 1];
  if (typeof first.content === 'string' && first.content.includes('[GÖNDERİ YORUMU]')) {
    return { content: [{ type: 'text', text: JSON.stringify({ public_reply: '❤️ Fiyatı 1.199 TL, detay için DM atın 📩', dm: 'Merhaba, Tazz Bej 1.199 TL. Numaranız?' }) }], stop_reason: 'end_turn' };
  }
  const last = req.messages[req.messages.length - 1];
  if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') results.push(JSON.parse(last.content[0].content));
  const step = script.shift();
  if (!step) return { content: [{ type: 'text', text: 'tamam' }], stop_reason: 'end_turn' };
  return { content: [{ type: 'tool_use', id: `t${Math.random()}`, name: step.name, input: step.input }], stop_reason: 'tool_use' };
};
const send = { text: async () => {}, image: async () => {} };
const run = async (uid, text, withImage = false) => { results = []; await ai.handleDirectMessage({ userId: uid, text, imageUrl: withImage ? 'https://m.com/img/c.png' : undefined, send }); };
const order = (items) => ({ name: 'type_order', customer_name: 'Ayşe Yılmaz', phone: '05551234567', address: 'Atatürk Mah. Gül Sok. No 5 Daire 3', city: 'Ankara', district: 'Çankaya', items });

// 1) sipariş -> etiket + hafıza + Telegram
script = [{ name: 'submit_order', input: order([{ product_id: p1.id, size: '37', qty: 1 }]) }];
await run('c1', 'sipariş vermek istiyorum');
ok(results[0]?.ok && results[0].siparis_no, `sipariş alındı (no ${results[0]?.siparis_no})`);
ok(tg.some((t) => t.includes('YENİ SİPARİŞ') && t.includes('SİPARİŞ VERDİ') && /Kargo ücreti: \+100/.test(t)), 'Telegram siparişi: no, "SİPARİŞ VERDİ" etiketi, 100 TL kargo');
ok(customers.get('c1').orders.length === 1, 'müşteri kaydında sipariş var');
await run('c1', 'siparişimde ne vardı?');
ok(/SİPARİŞ VERDİ olarak işaretli/.test(systems.at(-1)) && /Tazz Bej/.test(systems.at(-1)), 'sonraki sorularda sipariş bilgisi bota veriliyor');

// 2) 3 saat içinde iptal
script = [{ name: 'cancel_order', input: {} }];
await run('c1', 'siparişi iptal edin');
ok(results[0].ok && results[0].durum === 'iptal_edildi', 'süre içinde iptal edildi');
ok(tg.some((t) => t.includes('SİPARİŞ İPTAL EDİLDİ') && t.includes('HAZIRLAMAYIN')), 'iptal Telegram grubuna iletildi');
ok(customers.get('c1').orders[0].status === 'iptal', 'sipariş durumu iptal');

// 3) 3 saatten sonra iptal reddedilir
script = [{ name: 'submit_order', input: { ...order([{ product_id: p2.id, size: '37', qty: 1 }]), phone: '05559876543' } }];
await run('c2', 'sipariş');
const real = Date.now; const t0 = real();
Date.now = () => t0 + 4 * 3600e3;
const n = tg.length;
script = [{ name: 'cancel_order', input: {} }];
await run('c2', 'iptal etmek istiyorum');
Date.now = real;
ok(results[0].ok === false && results[0].durum === 'sure_gecti' && /kargoya teslim edilmiş/.test(results[0].not), '4 saat sonra iptal edilmedi, ikna metni döndü');
ok(!tg.slice(n).some((t) => t.includes('SİPARİŞ İPTAL EDİLDİ')), 'iptal bildirimi gitmedi');
ok(customers.get('c2').orders[0].status === 'aktif', 'sipariş aktif kaldı');

// 4) kayıtsız müşteri iptal -> yönlendirme
script = [{ name: 'cancel_order', input: {} }];
await run('c3', 'iptal');
ok(results[0].durum === 'siparis_yok', 'kayıtlı sipariş yoksa WhatsApp yönlendirme notu');

// 5) memnuniyet fotoğrafı
script = [{ name: 'send_satisfaction_photo', input: { note: 'çok beğendim' } }];
await run('c2', 'elime ulaştı', true);
ok(results[0].ok && photos.length === 1 && /MEMNUNİYET/.test(photos[0]) && /Roven/.test(photos[0]), 'memnuniyet fotoğrafı Telegram grubuna gitti (sipariş bilgisiyle)');

// 6) yorum hafızası
const r = await ai.handleComment({ userId: 'c4', username: 'ali', commentText: 'fiyat ne kadar?', mediaCaption: 'Tazz Bej yeni sezon' });
ok(/DM/.test(r.publicReply) && r.dm, 'yorum: herkese açık cevap DM daveti içeriyor, DM hazır');
ok(/fiyat ne kadar/.test(customers.contextText('c4')) && /1\.199/.test(customers.contextText('c4')), 'yorum ve cevaplar müşteri hafızasında');
script = [];
await run('c4', 'numaram 37');
ok(/Herkese açık cevabımız/.test(systems.at(-1)), 'DM sohbetinde yorum bağlamı bota veriliyor');

// 7) kalıcılık
await new Promise((r2) => setTimeout(r2, 800));
const fs = await import('node:fs');
ok(JSON.parse(fs.readFileSync(cfg.customersFile, 'utf8')).c2.orders.length === 1, 'hafıza dosyaya yazıldı');

console.log(fail ? `\n${fail} test BAŞARISIZ` : '\nSipariş/yorum testleri geçti');
process.exit(fail ? 1 : 0);
