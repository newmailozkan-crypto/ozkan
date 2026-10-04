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
ok(/KAPIDA ÖDEME/.test(t) && /şeffaf/i.test(t) && /DHL/.test(t), 'kapıda ödeme, şeffaf kargo, DHL');
ok(/çakma.*ASLA/s.test(t), 'kalite kelime yasağı');
ok(/37\.5/.test(t), 'buçuklu numara kuralı');

ok(/bir numara büyük/i.test(fitNote('Hafif taban. Kalıbı dardır, bir numara büyük alınız. Taba rengi.')), 'kalıp notu ayıklanır');
ok(fitNote('Hasır desenli, hafif.') === '', 'özel not yoksa boş');

// hatırlatma
process.env.TZ = 'UTC';
ai.noteUserMessage('u1');
ai.noteBotMessage('u1');
ok(ai.dueFollowups().length === 0, 'görüldü gelmeden hatırlatma yok');
ai.noteSeen('u1');
ok(ai.dueFollowups().length === 0, 'görüldü ama 6 saat dolmadan hatırlatma yok');
const real = Date.now;
const noon = new Date('2026-10-05T09:00:00Z').getTime(); // 12:00 İstanbul
Date.now = () => noon;
ai.noteUserMessage('u2'); ai.noteBotMessage('u2'); ai.noteSeen('u2');
Date.now = () => noon + 7 * 3600e3 - 3 * 3600e3; // 4 saat sonra (gündüz)
ok(!ai.dueFollowups().includes('u2'), '4 saat: henüz yok');
Date.now = () => noon + 6.1 * 3600e3; // 18:06 İstanbul
ok(ai.dueFollowups().includes('u2'), 'görüldü + 6 saat: hatırlatma zamanı');
Date.now = () => noon + 6.1 * 3600e3 + 1;
ai.noteUserMessage('u2'); ai.noteBotMessage('u2');
ok(!ai.dueFollowups().includes('u2'), 'müşteri yazınca sayaç sıfırlanır');
Date.now = () => noon + 16 * 3600e3; // gece 01:00 İstanbul
ai.noteUserMessage('u3'); Date.now = () => noon + 9 * 3600e3; ai.noteBotMessage('u3'); ai.noteSeen('u3');
Date.now = () => noon + 16 * 3600e3;
ok(!ai.dueFollowups().includes('u3'), 'gece saatlerinde hatırlatma gönderilmez');
Date.now = real;
if (fail) { console.log(`${fail} test başarısız`); process.exit(1); }
console.log('Kural testleri geçti');
process.exit(0);
