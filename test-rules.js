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

let r = priceCart([1800]);
ok(r.indirim_tl === 0 && r.kargo_ucreti_tl === 100 && r.odenecek_toplam_tl === 1900, '1 ürün 1800 TL: indirim yok, 100 TL kargo');
r = priceCart([2500, 1500]);
ok(r.indirim_tl === 400 && r.indirim_sonrasi_tl === 3600 && r.kargo_ucreti_tl === 0 && r.odenecek_toplam_tl === 3600, '2 ürün (2500+1500): 400 TL indirim, 3600 TL, kargo ücretsiz');
r = priceCart([1500, 1500]);
ok(r.indirim_tl === 400 && r.indirim_sonrasi_tl === 2600 && r.kargo_ucreti_tl === 0, '2 x 1500: 400 TL indirim, 2600 TL >= 2500 kargo ücretsiz');
r = priceCart([1200, 1200]);
ok(r.indirim_tl === 400 && r.indirim_sonrasi_tl === 2000 && r.kargo_ucreti_tl === 100 && r.odenecek_toplam_tl === 2100, '2 x 1200: 2000 TL < 2500 -> 100 TL kargo');
r = priceCart([1500, 1500, 1500]);
ok(r.indirim_tl === 400 && r.ipuclari.some((x) => /4 ürün/.test(x)), '3 ürün: 400 TL indirim, 4. ürüne teşvik ipucu');
r = priceCart([2500, 2000, 1500, 1200]);
ok(r.indirim_tl === 800 && r.indirim_sonrasi_tl === 7200 - 800, '4 ürün: 800 TL indirim');
r = priceCart([2000, 1800, 1600, 1400, 1200]);
ok(r.indirim_tl === 800, '5 ürün: 800 TL indirim');
r = priceCart([2000, 1800, 1600, 1400, 1200, 1000]);
ok(r.indirim_tl === 1200 && r.kargo_ucreti_tl === 0, '6 ürün: 1200 TL indirim');
r = priceCart([300, 300]);
ok(r.indirim_tl === 400 && r.indirim_sonrasi_tl === 200, 'indirim ara toplamı aşmaz (sınır kontrolü 600 TL sepette 400 TL)');
ok(priceCart([2500]).kargo_ucreti_tl === 0, 'tam 2500 TL: kargo ücretsiz');

const t = storeRulesText();
ok(/400 TL/.test(t) && /800 TL/.test(t) && /1\.200 TL/.test(t) && /ESKİ KAMPANYALAR İPTAL/.test(t), 'kurallarda yeni kampanya (400/800/1200 TL) ve eski kampanyaların iptali var');
ok(!/her 2 ürün alımı için toplam 300/.test(t), 'eski 300 TL kampanya kuralı metinden kalktı');
ok(/wa\.me\/905451348934/.test(t), 'WhatsApp linki kurallarda');
ok(/paketi açtırmaz/.test(t) && /hızlı şekilde DEĞİŞİM/.test(t) && !/önce görürsün, sonra ödersin/.test(t), 'şeffaf kargo doğru tanımlı (görünür, ödeyip teslim alınır, açılıp denenmez, sonra hızlı değişim)');
ok(/KAPIDA ÖDEME/.test(t) && /şeffaf/i.test(t) && /DHL/.test(t), 'kapıda ödeme, şeffaf kargo, DHL');
ok(/çakma.*ASLA/s.test(t), 'kalite kelime yasağı');
ok(/37\.5/.test(t), 'buçuklu numara kuralı');

ok(/bir numara büyük/i.test(fitNote('Hafif taban. Kalıbı dardır, bir numara büyük alınız. Taba rengi.')), 'kalıp notu ayıklanır');
ok(fitNote('Hasır desenli, hafif.') === '', 'özel not yoksa boş');

// hatırlatma (kalıcı, gece dahil, görüldü şartı yok)
const real = Date.now;
const due = (u, st) => ai.dueFollowups().some((x) => x.userId === u && (st === undefined || x.stage === st));
const noon = new Date('2026-10-05T09:00:00Z').getTime(); // 12:00 İstanbul
Date.now = () => noon;
ai.noteUserMessage('u2'); ai.noteBotMessage('u2');
Date.now = () => noon + 5 * 3600e3;
ok(!due('u2'), '5 saat: henüz yok');
Date.now = () => noon + 6.1 * 3600e3;
ok(due('u2'), '6 saat sonra: görüldü bilgisi olmasa da hatırlatma zamanı');
Date.now = () => noon + 6.1 * 3600e3 + 1;
ai.noteUserMessage('u2'); ai.noteBotMessage('u2');
ok(!due('u2'), 'müşteri yazınca sayaç sıfırlanır');
// gece yarısına denk gelen
Date.now = () => noon + 12 * 3600e3; // 00:00 İstanbul
ai.noteUserMessage('u3'); ai.noteBotMessage('u3');
Date.now = () => noon + 18.2 * 3600e3; // 06:12 İstanbul
ok(due('u3'), 'saat kaça denk gelirse gelsin (gece/sabah) hatırlatma gider');
// 24 saatlik pencere
ai.noteUserMessage('u4'); ai.noteBotMessage('u4');
Date.now = () => noon + 18.2 * 3600e3 + 24.5 * 3600e3;
ok(!due('u4'), '24 saatlik mesaj penceresi kapanınca gönderilmez');
// tek seferlik
Date.now = () => noon + 18.2 * 3600e3 + 1000;
const f1 = ai.buildFollowup('u3', 1);
ok(/karar/i.test(f1.text) && !/hediye|249/.test(f1.text) && !f1.imageUrl, '1. aşama: teklifsiz nazik hatırlatma');
ok(!due('u3'), 'aynı aşama tekrar gitmez');
Date.now = () => noon + 28.5 * 3600e3;
ok(due('u3', 2), '16. saatte 2. aşama (hediye teklifi) zamanı');
const f2 = ai.buildFollowup('u3', 2);
ok(/249/.test(f2.text) && /Nike/.test(f2.text) && /kısa süreli/.test(f2.text), '2. aşama: 249 ₺ Nike çorap hediye teklifi');
ok(!due('u3'), 'iki aşama sonrası tekrar yok');
Date.now = () => noon + 18.2 * 3600e3 + 1000;
// insan yazışırken hatırlatma yok
Date.now = () => noon + 30 * 3600e3;
ai.noteUserMessage('u5'); ai.humanMessage('u5', 'Merhaba, size yardımcı olayım');
Date.now = () => noon + 30 * 3600e3 + 3600e3;
ok(!due('u5'), 'insan yazışırken bot hatırlatma atmaz');
Date.now = real;

// cevap denetimi: yanlış ücretsiz kargo baremi
ok(ai.auditReply('Evet haklısınız, 1000 TL ve üzeri siparişlerde kargo ücretsiz!').length === 1, 'denetim: "1000 TL üzeri kargo ücretsiz" yakalanır');
ok(ai.auditReply('Ücretsiz kargo baremimiz 2.500 TL ve üzeri siparişlerdir.').length === 0, 'denetim: doğru barem geçer');
ok(ai.auditReply('Sepetiniz 2.100 TL, 400 TL daha eklerseniz kargo ücretsiz olur.').length === 0, 'denetim: kalan tutar cümlesi yanlış pozitif vermez');

if (fail) { console.log(`${fail} test başarısız`); process.exit(1); }
console.log('Kural testleri geçti');
process.exit(0);
