import os from 'node:os';
import path from 'node:path';
process.env.CUSTOMERS_FILE = path.join(os.tmpdir(), `cust-rules-${Date.now()}.json`);
process.env.LEARNED_FILE = path.join(os.tmpdir(), `learn-rules-${Date.now()}.json`);
process.env.ANTHROPIC_API_KEY = 'x';
process.env.TELEGRAM_BOT_TOKEN = 't';
process.env.TELEGRAM_CHAT_ID = '1';
const { priceCart, storeRulesText } = await import('./src/storeRules.js');
const { fitNote } = await import('./src/catalog.js');
const ai = await import('./src/ai.js');
let fail = 0;
const ok = (c, m) => { console.log(c ? 'OK  ' : 'FAIL', m); if (!c) fail++; };

let r = priceCart(1800, 1);
ok(r.indirim_tl === 0 && r.kargo_ucreti_tl === 100 && r.odenecek_toplam_tl === 1900, '1 ürün 1800 TL: indirim yok, 100 TL kargo');
r = priceCart(3600, 2);
ok(r.indirim_tl === 300 && r.kargo_ucreti_tl === 0 && r.odenecek_toplam_tl === 3300, '2 ürün: 300 TL indirim, kargo ücretsiz');
r = priceCart(2600, 2);
ok(r.indirim_tl === 300 && r.indirim_sonrasi_tl === 2300 && r.kargo_ucreti_tl === 100, '2 ürün 2600: indirim sonrası 2300 < 2500 -> kargo 100');
r = priceCart(5400, 3);
ok(r.indirim_tl === 300 && r.ipuclari.some((x) => /4\. ürün|indirim 600/.test(x)), '3 ürün: 4. ürüne teşvik ipucu');
r = priceCart(7200, 4);
ok(r.indirim_tl === 600 && r.odenecek_toplam_tl === 6600, '4 ürün: 600 TL indirim');
r = priceCart(9000, 5);
ok(r.indirim_tl === 600, '5 ürün: 600 TL');
ok(priceCart(2500, 1).kargo_ucreti_tl === 0, 'tam 2500 TL: kargo ücretsiz');

const t = storeRulesText();
ok(/wa\.me\/905451348934/.test(t), 'WhatsApp linki kurallarda');
ok(/önce görürsün, sonra ödersin/.test(t) && !/içeriği belli olmayan paket\)/.test(t), 'şeffaf kargo doğru tanımlı (ürünü görüp sonra ödeme)');
ok(/KAPIDA ÖDEME/.test(t) && /şeffaf/i.test(t) && /DHL/.test(t), 'kapıda ödeme, şeffaf kargo, DHL');
ok(/çakma.*ASLA/s.test(t), 'kalite kelime yasağı');
ok(/37\.5/.test(t), 'buçuklu numara kuralı');

ok(/bir numara büyük/i.test(fitNote('Hafif taban. Kalıbı dardır, bir numara büyük alınız. Taba rengi.')), 'kalıp notu ayıklanır');
ok(fitNote('Hasır desenli, hafif.') === '', 'özel not yoksa boş');

// hatırlatma (kalıcı, gece dahil, görüldü şartı yok)
const real = Date.now;
const noon = new Date('2026-10-05T09:00:00Z').getTime(); // 12:00 İstanbul
Date.now = () => noon;
ai.noteUserMessage('u2'); ai.noteBotMessage('u2');
Date.now = () => noon + 5 * 3600e3;
ok(!ai.dueFollowups().includes('u2'), '5 saat: henüz yok');
Date.now = () => noon + 6.1 * 3600e3;
ok(ai.dueFollowups().includes('u2'), '6 saat sonra: görüldü bilgisi olmasa da hatırlatma zamanı');
Date.now = () => noon + 6.1 * 3600e3 + 1;
ai.noteUserMessage('u2'); ai.noteBotMessage('u2');
ok(!ai.dueFollowups().includes('u2'), 'müşteri yazınca sayaç sıfırlanır');
// gece yarısına denk gelen
Date.now = () => noon + 12 * 3600e3; // 00:00 İstanbul
ai.noteUserMessage('u3'); ai.noteBotMessage('u3');
Date.now = () => noon + 18.2 * 3600e3; // 06:12 İstanbul
ok(ai.dueFollowups().includes('u3'), 'saat kaça denk gelirse gelsin (gece/sabah) hatırlatma gider');
// 24 saatlik pencere
ai.noteUserMessage('u4'); ai.noteBotMessage('u4');
Date.now = () => noon + 18.2 * 3600e3 + 24.5 * 3600e3;
ok(!ai.dueFollowups().includes('u4'), '24 saatlik mesaj penceresi kapanınca gönderilmez');
// tek seferlik
Date.now = () => noon + 18.2 * 3600e3 + 1000;
await ai.buildFollowup('u3');
ok(!ai.dueFollowups().includes('u3'), 'hatırlatma tek seferlik');
// insan yazışırken hatırlatma yok
Date.now = () => noon + 30 * 3600e3;
ai.noteUserMessage('u5'); ai.humanMessage('u5', 'Merhaba, size yardımcı olayım');
Date.now = () => noon + 30 * 3600e3 + 3600e3;
ok(!ai.dueFollowups().includes('u5'), 'insan yazışırken bot hatırlatma atmaz');
Date.now = real;

// cevap denetimi: yanlış ücretsiz kargo baremi
ok(ai.auditReply('Evet haklısınız, 1000 TL ve üzeri siparişlerde kargo ücretsiz!').length === 1, 'denetim: "1000 TL üzeri kargo ücretsiz" yakalanır');
ok(ai.auditReply('Ücretsiz kargo baremimiz 2.500 TL ve üzeri siparişlerdir.').length === 0, 'denetim: doğru barem geçer');
ok(ai.auditReply('Sepetiniz 2.100 TL, 400 TL daha eklerseniz kargo ücretsiz olur.').length === 0, 'denetim: kalan tutar cümlesi yanlış pozitif vermez');

if (fail) { console.log(`${fail} test başarısız`); process.exit(1); }
console.log('Kural testleri geçti');
process.exit(0);
