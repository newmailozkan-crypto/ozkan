// Paylaşılan gönderi/reels/hikaye çözümü, "yanıtla" ile seçilen ürün ve kendi fotoğrafımızı geri gönderme (sahte ağ + sahte Claude).
// Not: dHash testleri gerçek "sharp" ister; yoksa o bölüm atlanır.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CUSTOMERS_FILE = path.join(os.tmpdir(), `cust-${Date.now()}.json`);
process.env.CATALOG_STORE_FILE = path.join(os.tmpdir(), `store-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`);
process.env.ANTHROPIC_API_KEY = 'x';
process.env.IG_ACCESS_TOKEN = 'tok';
const { cfg } = await import('./src/config.js');
cfg.tgToken = 't'; cfg.tgChatId = '1';
const { initImages } = await import('./src/images.js');
const hasSharp = await initImages();
const { pushFeed, allProducts } = await import('./src/catalog.js');
const { resolveShared } = await import('./src/media.js');
const ai = await import('./src/ai.js');

let fail = 0;
const ok = (c, m) => { console.log(c ? 'OK  ' : 'FAIL', m); if (!c) fail++; };

// --- sentetik görseller ---
const sharp = hasSharp ? (await import('sharp')).default : null;
const synth = async (seed) => {
  const w = 64, h = 64, px = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (Math.sin((x + seed * 7) / (3 + seed)) * 90 + Math.cos((y * (seed + 1)) / 5) * 90 + 128) & 255;
  return sharp(px, { raw: { width: w, height: h, channels: 1 } }).jpeg().toBuffer();
};
const A = hasSharp ? await synth(1) : Buffer.from('a');
const B = hasSharp ? await synth(4) : Buffer.from('b');
const C = hasSharp ? await synth(9) : Buffer.from('c');
const MP4 = '/tmp/share-test.mp4';
spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-pix_fmt', 'yuv420p', MP4], { stdio: 'ignore' });
const mp4 = fs.readFileSync(MP4);

const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push(u);
  const res = (status, body, type) => ({ ok: status < 400, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) }, json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => String(body), arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  if (u.startsWith('https://api.telegram.org')) return res(200, '{}', 'application/json');
  if (u.includes('graph.instagram.com')) {
    if (/\/111\?/.test(u)) return res(200, { id: '111', caption: 'Tazz Bej yeni sezon 🔥', thumbnail_url: 'https://cdn.test/a.jpg' }, 'application/json');
    if (u.includes('/me/media') || u.includes('/me/stories')) return res(200, { data: [{ id: '333', caption: 'Roven Kahve', permalink: 'https://www.instagram.com/reel/ABC123/', thumbnail_url: 'https://cdn.test/b.jpg' }] }, 'application/json');
    return res(400, { error: { message: 'nope' } }, 'application/json');
  }
  if (u === 'https://cdn.test/a.jpg') return res(200, A, 'image/jpeg');
  if (u === 'https://cdn.test/b.jpg') return res(200, B, 'image/jpeg');
  if (u === 'https://cdn.test/v.mp4') return res(200, mp4, 'video/mp4');
  if (u === 'https://cdn.test/story.jpg') return res(200, C, 'image/jpeg');
  if (u.includes('/img/tazz-bej')) return res(200, A, 'image/jpeg');
  if (u.includes('/img/roven')) return res(200, B, 'image/jpeg');
  return res(404, 'yok', 'text/plain');
};

// 1) paylaşılan gönderi: kendi medya kimliğimiz
let r = await resolveShared([{ type: 'share', payload: { ig_post_media_id: '111', url: 'https://lookaside.fbsbx.com/x' } }], null);
ok(r.image && /Tazz Bej/.test(r.caption) && r.debug.kaynak === 'kendi_medyamiz', 'paylaşılan gönderi: kimlikten görsel + açıklama alındı');

// 2) reels: kimlik tutmaz ama permalink listemizde -> küçük resim
r = await resolveShared([{ type: 'ig_reel', payload: { reel_video_id: '999', url: 'https://www.instagram.com/reel/ABC123/', title: '' } }], null);
ok(r.image && /Roven/.test(r.caption), 'reels: permalink ile kendi medyamızdan bulundu');

// 3) reels: bizim değil, video adresinden kare çıkarma
r = await resolveShared([{ type: 'ig_reel', payload: { url: 'https://cdn.test/v.mp4', title: 'Siyah sneaker' } }], null);
ok(r.image && r.debug.kaynak === 'ek_adresi' && r.caption === 'Siyah sneaker', 'reels videosundan ffmpeg ile kare çıkarıldı, başlık alındı');

// 4) hikayeye yanıt
r = await resolveShared([], { id: 's1', url: 'https://cdn.test/story.jpg' });
ok(r.image && r.kind === 'hikaye yanıtı', 'hikaye yanıtı: hikaye görseli alındı');

// 5) çözülemeyen paylaşım
r = await resolveShared([{ type: 'share', payload: { url: 'https://www.instagram.com/p/ZZZ/', title: 'Platform Taba' } }], null);
ok(!r.image && r.caption === 'Platform Taba', 'okunamayan paylaşım: görsel yok ama başlık korunur');
r = await resolveShared([{ type: 'audio', payload: { url: 'x' } }], null);
ok(r === null, 'ses/dosya eki paylaşım sayılmaz');

// --- katalog + sahte Claude ---
const item = (grp, title, size, img) => `<item><g:id>${grp}-${size}</g:id><g:title>${title}</g:title><g:description>Hafif. ${grp}</g:description><g:availability>in stock</g:availability><g:price>2999.00 TRY</g:price><g:sale_price>1199.00 TRY</g:sale_price><g:link>https://m.com/product/${grp}/?attribute_pa_numara=${size}</g:link><g:image_link>https://m.com/img/${img}.png</g:image_link><g:item_group_id>${grp}</g:item_group_id><product_type>Sneaker</product_type></item>`;
pushFeed(`<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel>${item('tazz-bej', 'Tazz Bej', 37, 'tazz-bej')}${item('roven', 'Roven Kahve', 37, 'roven')}</channel></rss>`, 'h');
const prods = allProducts();
const tazz = prods.find((p) => p.title === 'Tazz Bej');

let script = [], results = [], lastUser = '';
globalThis.__claudeStub = async (req) => {
  if (!req.system) {
    const text = req.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const ids = [...text.matchAll(/Aday id=(\S+) \|/g)].map((m) => m[1]);
    return { content: [{ type: 'text', text: JSON.stringify({ eslesmeler: ids.map((id) => ({ id, guven: id.startsWith('roven') ? 0.8 : 0.3, neden: '' })) }) }], stop_reason: 'end_turn' };
  }
  const last = req.messages[req.messages.length - 1];
  if (typeof last.content === 'string') lastUser = last.content;
  else if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') results.push(JSON.parse(last.content[0].content));
  else lastUser = last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const step = script.shift();
  if (!step) return { content: [{ type: 'text', text: 'tamam' }], stop_reason: 'end_turn' };
  return { content: [{ type: 'tool_use', id: `t${Math.random()}`, name: step.name, input: step.input }], stop_reason: 'tool_use' };
};
const sent = [];
const send = { text: async (t, pid) => sent.push(['text', t, pid]), image: async (u, pid) => sent.push(['image', u, pid]) };
const run = async (uid, args) => { results = []; sent.length = 0; return ai.handleDirectMessage({ userId: uid, send, ...args }); };

// 6) "yanıtla" ile seçilen ürün
script = [];
await run('u1', { text: 'bunu istiyorum', replyTo: { productId: tazz.id, text: '(ürün fotoğrafı)' } });
ok(/SEÇİLEN ÜRÜN/.test(lastUser) && /Tazz Bej/.test(lastUser), 'yanıtlanan ürün bota "SEÇİLEN ÜRÜN" olarak bildirildi');
await run('u1', { text: 'tamam', replyTo: { unknown: true } });
ok(/içeriği bilinmiyor/.test(lastUser), 'bilinmeyen yanıtlanan mesaj için not eklendi');
await run('u1', { text: 'bu ne kadar', replyTo: { text: 'Tazz Bej — 1.199 TL' } });
ok(/yanıt verdi: "Tazz Bej/.test(lastUser), 'yanıtlanan metin bota iletildi');

// 7) paylaşılan gönderi bota görsel + not ile gider
script = [{ name: 'match_customer_image', input: {} }];
await run('u2', { text: '', imageData: { b64: B.toString('base64'), mediaType: 'image/jpeg' }, notes: ['Müşteri bir Instagram paylaşımını (reel) iletti; görseli ekledim.'], caption: 'Roven Kahve' });
ok(/paylaşımını \(reel\)/.test(lastUser) && results[0]?.durum, `paylaşım görseli eşleştirmeye gitti (${results[0]?.durum})`);

// 8) kendi fotoğrafımızı geri gönderme
if (hasSharp) {
  script = [{ name: 'show_models', input: { size: '37', count: 3 } }];
  await run('u3', { text: 'modeller neler' });
  ok(sent.filter((s) => s[0] === 'image').length === 2, 'önce modeller gösterildi');
  script = [{ name: 'match_customer_image', input: { size: '37' } }];
  const recompressed = await sharp(A).jpeg({ quality: 60 }).toBuffer();
  await run('u3', { text: '', imageData: { b64: recompressed.toString('base64'), mediaType: 'image/jpeg' } });
  ok(results[0]?.musterinin_sectigi_urun === true && results[0].durum === 'stokta', `müşteri bizim fotoğrafı geri gönderdi -> seçilen ürün (${results[0]?.durum})`);
  ok(sent.filter((s) => s[0] === 'image').length === 0, 'aynı fotoğraf tekrar gönderilmedi, "benzer" denmedi');
  script = [{ name: 'match_customer_image', input: { size: '37' } }];
  await run('u3', { text: '', imageData: { b64: C.toString('base64'), mediaType: 'image/jpeg' } });
  ok(!results[0]?.musterinin_sectigi_urun, 'bambaşka bir görsel "seçilen ürün" sayılmadı');
} else {
  console.log('SKIP dHash testleri (sharp yok)');
}

console.log(fail ? `\n${fail} test BAŞARISIZ` : '\nPaylaşım/yanıtla testleri geçti');
process.exit(fail ? 1 : 0);
