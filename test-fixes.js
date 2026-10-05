// Yeni davranışlar: ikinci ürün kapısı, kuralları savunma (denetim), insan devri + öğrenme, yorumda net fiyat, botun kendi mesajını tanıma
import os from 'node:os';
import path from 'node:path';
process.env.CUSTOMERS_FILE = path.join(os.tmpdir(), `cust-fix-${Date.now()}.json`);
process.env.LEARNED_FILE = path.join(os.tmpdir(), `learn-fix-${Date.now()}.json`);
process.env.CATALOG_STORE_FILE = path.join(os.tmpdir(), `store-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`);
process.env.ANTHROPIC_API_KEY = 'x';
process.env.IG_ACCESS_TOKEN = 'tok';
const { cfg } = await import('./src/config.js');
cfg.tgToken = 't'; cfg.tgChatId = '1';
const { pushFeed, allProducts } = await import('./src/catalog.js');
const customers = await import('./src/customers.js');
const ai = await import('./src/ai.js');
const ig = await import('./src/instagram.js');

let fail = 0;
const ok = (c, m) => { console.log(c ? 'OK  ' : 'FAIL', m); if (!c) fail++; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let msgN = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const res = (body, type) => ({ ok: true, status: 200, headers: { get: () => type }, text: async () => '', json: async () => body, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) });
  if (u.includes('/me/messages')) return res({ recipient_id: 'x', message_id: `mid.${++msgN}` }, 'application/json');
  if (u.startsWith('https://api.telegram.org')) return res({ ok: true }, 'application/json');
  return res(PNG, 'image/png');
};
const item = (grp, title, size) => `<item><g:id>${grp}-${size}</g:id><g:title>${title}</g:title><g:description>Hafif. ${grp}</g:description><g:availability>in stock</g:availability><g:price>2999.00 TRY</g:price><g:sale_price>1199.00 TRY</g:sale_price><g:link>https://m.com/product/${grp}/?attribute_pa_numara=${size}</g:link><g:image_link>https://m.com/img/${grp}.png</g:image_link><g:item_group_id>${grp}</g:item_group_id><product_type>Sneaker</product_type></item>`;
pushFeed(`<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel>${['tazz-bej:Tazz Bej', 'roven:Roven Kahve', 'elevate:Elevate Beyaz', 'platform:Platform Taba', 'nova:Nova Siyah', 'luna:Luna Gri'].map((x) => { const [g, t] = x.split(':'); return item(g, t, 37); }).join('')}</channel></rss>`, 'h');
const tazz = allProducts().find((p) => p.title === 'Tazz Bej');

let script = [], results = [], systems = [], lastUser = '', lastReqMessages = [];
globalThis.__claudeStub = async (req) => {
  if (!req.system) {
    const text = req.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const ids = [...text.matchAll(/Aday id=(\S+) \|/g)].map((m) => m[1]);
    return { content: [{ type: 'text', text: JSON.stringify({ eslesmeler: ids.map((id) => ({ id, guven: id.startsWith('tazz-bej') ? 0.9 : 0.2, neden: '' })) }) }], stop_reason: 'end_turn' };
  }
  systems.push(req.system.map((b) => b.text).join('\n'));
  lastReqMessages = req.messages;
  if (req.tool_choice?.type === 'none') return { content: [{ type: 'text', text: 'Ücretsiz kargo baremimiz 2.500 TL ve üzeri siparişlerdir efendim 😊' }], stop_reason: 'end_turn' };
  const last = req.messages[req.messages.length - 1];
  if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') results.push(JSON.parse(last.content[0].content));
  else lastUser = typeof last.content === 'string' ? last.content : last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const step = script.shift();
  if (!step) return { content: [{ type: 'text', text: 'tamam' }], stop_reason: 'end_turn' };
  if (step.text) return { content: [{ type: 'text', text: step.text }], stop_reason: 'end_turn' };
  return { content: [{ type: 'tool_use', id: `t${Math.random()}`, name: step.name, input: step.input }], stop_reason: 'tool_use' };
};
const send = { text: async () => {}, image: async () => {} };
const run = async (uid, text) => { results = []; return ai.handleDirectMessage({ userId: uid, text, send }); };
const order = { customer_name: 'Ayşe Yılmaz', phone: '05551234567', address: 'Atatürk Mah. Gül Sok. No 5 Daire 3', city: 'Ankara', district: 'Çankaya', items: [{ product_id: tazz.id, size: '37', qty: 1 }] };

// 1) ikinci ürün (upsell) kapısı
script = [{ name: 'submit_order', input: order }];
await run('o1', 'bilgilerim bunlar');
ok(results[0].ok === false && results[0].hatalar.includes('UPSELL_YAPILMADI'), 'upsell yapmadan sipariş tamamlanamaz');
script = [{ name: 'suggest_upsell', input: { size: '37', count: 5 } }, { name: 'submit_order', input: order }];
await run('o1', 'devam');
ok(results[1].ok === false && results[1].hatalar.includes('UPSELL_YAPILMADI'), 'upsell ile aynı mesajda sipariş tamamlanamaz (müşteri cevabı beklenmeli)');
script = [{ name: 'submit_order', input: order }];
await run('o1', 'hayır sadece bu yeter');
ok(results[0].ok === true, 'müşteri upsell’e cevap verdikten sonra sipariş tamamlanır');

// 2) kuralları savunma: bot müşteriye hak verirse denetim düzeltir
script = [{ text: 'Evet haklısınız, 1000 TL ve üzeri siparişlerde kargo ücretsiz!' }];
const reply = await run('o2', '1000 tl üstü kargo ücretsiz olması lazım');
ok(/2\.500/.test(reply) && !/1000/.test(reply), `yanlış ücretsiz kargo baremi düzeltildi: "${reply}"`);

// 3) insan devri: izleme + öğrenme
script = [{ text: 'Merhaba, numaranız kaç?' }];
await run('h1', '37 numara var mı');
ai.humanMessage('h1', 'Evet 37 stokta, 05551234567 numaralı hattan arayabilirsiniz, siparişi alalım mı?');
ok(customers.humanActive('h1', cfg.handoffHours), 'insan yazınca bot devri aktif');
ai.observeCustomer('h1', 'olur alalım');
script = [{ text: 'tamam' }];
await run('h2', 'merhaba');
ok(/Müşteri: "37 numara var mı" → Ekibimizin cevabı: "Evet 37 stokta, … numaralı hattan/.test(systems.at(-1)), 'ekibin cevabı öğrenildi (telefon numarası silinerek) ve sonraki sohbetlerde örnek verildi');
script = [{ text: 'sipariş detaylarını alayım' }];
await run('h1', 'adresim şu');
ok(/Mağaza yetkilisi \(insan\) müşteriye şunu yazdı/.test(JSON.stringify(lastReqMessages)) && /olur alalım/.test(JSON.stringify(lastReqMessages)), 'devir sonrası bot, insanın ve müşterinin yazdıklarını bağlam olarak biliyor');

// 4) yorumda net fiyat: gönderi görselinden ürün bulunur
script = [{ text: JSON.stringify({ public_reply: 'Tazz Bej 1.199 TL ❤️ DM atın 📩', dm: '' }) }];
await ai.handleComment({ userId: 'k1', username: 'ali', commentText: 'fiyat?', mediaCaption: '', mediaId: 'm1', mediaImageUrl: 'https://cdn.test/post.jpg' });
ok(/Gönderideki ürün/.test(lastUser) && /Tazz Bej/.test(lastUser) && /1199/.test(lastUser), 'yorum: gönderideki ürün ve net fiyatı modele verildi');
ok(/ASLA fiyat aralığı/.test(lastUser), 'yorum: fiyat aralığı yasağı istemde');

// 5) botun kendi mesajı vs insan mesajı (echo ayrımı)
await ig.sendText('cust9', 'Merhaba, size nasıl yardımcı olabilirim?');
ok(ig.isOurMessage('cust9', 'mid.farkli', 'Merhaba, size nasıl yardımcı olabilirim?', false), 'botun kendi mesajının yankısı tanınır (metinle)');
ok(!ig.isOurMessage('cust9', 'mid.baska', 'Selam, ben mağazadan Ahmet', false), 'farklı metin = insan mesajı');
await ig.sendImage('cust9', 'https://x/y.jpg');
ok(ig.isOurMessage('cust9', 'mid.z', '', true), 'botun gönderdiği görselin yankısı tanınır');

console.log(fail ? `\n${fail} test BAŞARISIZ` : '\nDüzeltme testleri geçti');
process.exit(fail ? 1 : 0);
