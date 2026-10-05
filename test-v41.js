// 4.1 maddeleri: adres, yorumda fiyat, mesaj birleştirme, maliyet takibi, kurallar metni
import os from 'node:os';
import path from 'node:path';
process.env.USAGE_FILE = path.join(os.tmpdir(), `usage-${Date.now()}.json`);
process.env.CUSTOMERS_FILE = path.join(os.tmpdir(), `c41-${Date.now()}.json`);
process.env.ANTHROPIC_API_KEY = 'x';
let fail = 0;
const ok = (c, m) => { console.log(c ? 'OK  ' : 'FAIL', m); if (!c) fail++; };
const { buildAddress } = await import('./src/address.js');
const { enforceCommentPrice } = await import('./src/ai.js');
const { createBatcher } = await import('./src/batch.js');
const { record, usageReport, spentToday } = await import('./src/claude.js');
const { storeRulesText } = await import('./src/storeRules.js');
const { BOT_VERSION } = await import('./src/catalog.js');

// adres
let a = buildAddress({ mahalle: 'Atatürk', cadde_sokak: 'Gül Sok.', kapi_no: '5' });
ok(!a.ok && a.errors.some((e) => /DAİRE/.test(e)), 'kapı no var daire yok -> daire sorulur');
a = buildAddress({ mahalle: 'Atatürk', cadde_sokak: 'Gül Sok.', kapi_no: '5', daire_yok: true });
ok(a.ok, 'iş yeri/müstakil: daire_yok ile sipariş tamamlanır');
a = buildAddress({ cadde_sokak: 'Gül Sok.', kapi_no: '5', daire_no: '2' });
ok(!a.ok && a.errors.some((e) => /MAHALLE/.test(e)), 'mahalle eksik yakalanır');
a = buildAddress({ mahalle: 'Atatürk', cadde_sokak: 'Gül Sok.', kapi_no: '5', daire_no: '2', adres_notu: 'Migros karşısı' });
ok(a.ok && /\(Migros karşısı\)$/.test(a.address), 'işyeri/yer adı adresin sonuna parantezle eklenir: ' + a.address);

// yorumda fiyat
const items = [{ baslik: 'Tazz Bej', fiyat_tl: 1199 }];
let r = enforceCommentPrice('Teşekkürler ❤️ DM yazın', 'fiyat nedir', items);
ok(/Tazz Bej 1\.199 TL/.test(r) && /DM/.test(r), 'fiyat sorulup cevapta fiyat yoksa net fiyat + DM daveti eklenir: ' + r);
r = enforceCommentPrice('❤️ 1.199 TL, DM atın', 'kaç tl', items);
ok(r === '❤️ 1.199 TL, DM atın', 'doğru fiyat varsa dokunulmaz');
r = enforceCommentPrice('Teşekkürler', 'fiyat?', []);
ok(!/\d+\s*TL/.test(r) && /DM/.test(r), 'model bilinmiyorsa fiyat uydurulmaz, DM’den model sorulur');
r = enforceCommentPrice('Teşekkürler ❤️', 'çok güzel', items);
ok(r === 'Teşekkürler ❤️', 'fiyat sorusu değilse değişmez');

// mesaj birleştirme
const flushed = [];
const b = createBatcher(40, 200, (k, it) => flushed.push(it.length));
b.add('u', 1); b.add('u', 2); b.add('u', 3);
await new Promise((res) => setTimeout(res, 120));
ok(flushed.length === 1 && flushed[0] === 3, 'art arda 3 mesaj tek seferde işlenir');

// maliyet takibi
record('claude-haiku-4-5-20251001', { input_tokens: 1_000_000, output_tokens: 0 }, 'sohbet');
ok(Math.abs(spentToday() - 1) < 0.01, 'Haiku 1M giriş ≈ 1 USD hesaplanır');
ok(JSON.stringify(usageReport()).includes('sohbet'), 'kullanım raporu etiketli');

// kurallar
const rules = storeRulesText();
ok(/YALNIZCA TEK SİPARİŞTE/.test(rules) && /birleşmez/.test(rules), 'indirimler tek siparişle sınırlı');
ok(/paket/i.test(rules) && /ödeme/i.test(rules) && /değişim/i.test(rules), 'şeffaf kargo tanımı');
ok(BOT_VERSION.startsWith('4.1'), 'sürüm 4.1');
console.log(fail ? `\n${fail} test başarısız` : '\n4.1 testleri geçti');
process.exit(fail ? 1 : 0);
