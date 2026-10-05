// Gerçek feed biçimiyle (WooCommerce Product Feed Pro) ayrıştırma, renk/beden/model gruplama ve öneri akışını test eder.
// Çalıştırma: npm run test:feed
import { parseFeed, setProducts, hasSize, otherColors, similarProducts, suggestForSize, searchProducts, brief, parsePrice } from './src/catalog.js';

const SIZES = [35, 36, 37, 38, 39, 40, 41];
const DESC = {
  Platform: '<![CDATA[Ürünümüzün arkasında marka etiketi mevcuttur.Özellikler Listesi:Ürün Türü: Kadın Platform Ultra Mini BotDış Materyal: Kaliteli, yumuşak dokulu süet.İç Materyal: tam boy yoğun suni kürk astar.Taban: 5 cm platform EVA taban. Numara Aralığı: 35 - 41]]>',
  Tazz: '<![CDATA[Ürünümüzün arkasında marka etiketi mevcuttur.Özellikler Listesi:Ürün Türü: Kadın Tazz Terlik BotDış Materyal: süet.Taban: hafif düz EVA taban. Numara Aralığı: 35 - 41 numara arası geniş bedenler]]>',
  Lifestyle: '<![CDATA[Günlük kullanıma uygun leopar desenli kadın sneaker. Hafif ve rahat tabanı ile gün boyu konfor sağlar. Numara Aralığı: 35 - 41 numara arası]]>',
};

let nextId = 1000;
function model(name, color, groupId, img, { category = 'Home &amp;gt; Bot &amp;amp; Çizme', price = '2299.00', sale = '1099.00', outSizes = [], sameDesc = null } = {}) {
  const desc = DESC[sameDesc || name];
  return SIZES.map((s) => {
    const avail = outSizes.includes(s) ? 'out of stock' : 'in stock';
    return `<item>
<g:id>${nextId++}</g:id><g:title>${name} ${color}</g:title><g:description>${desc}</g:description>
<g:availability>${avail}</g:availability><g:condition>new</g:condition><g:price>${price} TRY</g:price>
<g:link>https://magaza.com/product/${name.toLowerCase()}-${color.toLowerCase().replace(/ı/g, 'i').replace(/\s+/g, '-')}/?attribute_pa_numara=${s}&amp;utm_source=Meta%20/%20Facebook%20Catalog%20Feed%20/%20Instagram&amp;utm_campaign=x.xml&amp;utm_medium=cpc&amp;utm_term=adtribes</g:link>
<g:image_link>https://magaza.com/wp-content/uploads/${groupId}.webp</g:image_link>
<g:item_group_id>${groupId}</g:item_group_id><product_type>${category}</product_type><g:sale_price>${sale} TRY</g:sale_price><identifier_exists>no</identifier_exists>
</item>`;
  }).join('\n');
}

const feed = (...parts) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>x</title>\n${parts.join('\n')}\n</channel></rss>`;

const realLike = feed(
  model('Platform', 'Acı Kahve', 19376, 'p1'),
  model('Platform', 'Vizon', 19364, 'p2', { outSizes: [37] }), // Vizon 37 tükenmiş
  model('Platform', 'Taba', 19352, 'p3'),
  model('Tazz', 'Taba', 19337, 't1'),
  model('Tazz', 'Vizon', 19324, 't2'),
  model('Tazz', 'Bej', 19311, 't3'),
  model('Tazz', 'Acı Kahve', 19300, 't4', { outSizes: [37, 38] }),
  model('Lifestyle', 'Leopar', 19182, 'l1', { category: 'Sneaker', price: '1899.00', sale: '1199.00' })
);

let fail = 0;
const ok = (c, m) => {
  console.log(c ? 'OK  ' : 'FAIL', m);
  if (!c) fail++;
};

const list = parseFeed(realLike);
setProducts(list);
const by = (m, c) => list.find((p) => p.modelName === m && p.color === c);

ok(list.length === 8, `56 satır -> renk bazında 8 ürün (bulunan: ${list.length})`);
ok(new Set(list.map((p) => p.modelKey)).size === 3, `3 model: platform, tazz, lifestyle (bulunan: ${[...new Set(list.map((p) => p.modelKey))].join(', ')})`);
ok(by('Platform', 'Acı Kahve') && by('Platform', 'Vizon') && by('Platform', 'Taba'), 'başlıktan model + renk ayrıldı (Platform / Acı Kahve, Vizon, Taba)');
ok(by('Lifestyle', 'Leopar'), 'tek renkli modelde de renk ayrıldı (Lifestyle / Leopar)');

const taba = by('Platform', 'Taba');
ok(taba.sizes.length === 7 && taba.sizes.map((s) => s.size).join(',') === '35,36,37,38,39,40,41', 'beden linkten okundu: 35-41');
ok(taba.price === 1099 && taba.priceOriginal === 2299, 'indirimli fiyat 1099, eski fiyat 2299');
ok(taba.category === 'Bot & Çizme', `kategori temizlendi: "${taba.category}"`);
ok(taba.url === 'https://magaza.com/product/platform-taba/', `link utm/numara parametresinden arındırıldı (${taba.url})`);
ok(brief(taba, '37').link === undefined && brief(taba, '37').secilen_beden_stokta === true, 'brief sade (link yok, seçilen beden stokta)');
ok(taba.images.length === 1 && taba.images[0].endsWith('.webp'), 'görsel adresi bellekte');

// --- stok mantığı ---
const vizon = by('Platform', 'Vizon');
ok(!hasSize(vizon, '37') && hasSize(vizon, '36') && hasSize(vizon, '38'), 'Platform Vizon: 37 tükenmiş, 36 ve 38 var');
ok(hasSize(taba, '37') && hasSize(taba, '37 Numara') && hasSize(taba, '37 (EU)'), '"37", "37 Numara", "37 (EU)" aynı sayılıyor');
ok(!hasSize(taba, '42') && !hasSize(taba, '34'), 'olmayan numaralar (34, 42) stokta değil');

// --- Senaryo: müşterinin ürününde numara yok -> aynı modelin diğer renkleri ---
const oc = otherColors(vizon, '37').map((p) => p.color).sort();
ok(oc.join('|') === 'Acı Kahve|Taba', `Platform Vizon 37 yok -> diğer renkler: ${oc.join(', ')}`);
ok(!otherColors(vizon, '37').some((p) => p.modelName === 'Tazz'), 'diğer renk önerisine başka model karışmadı');

// --- Senaryo: aynı modelin hiçbir renginde yok -> benzer modeller ---
const tazzAciKahve = by('Tazz', 'Acı Kahve');
ok(!hasSize(tazzAciKahve, '37'), 'Tazz Acı Kahve 37 tükenmiş');
ok(otherColors(tazzAciKahve, '37').length === 3, 'Tazz için 37 numara diğer 3 renkte var');

// bir modelin 37'si hiçbir renkte kalmamış gibi: tüm Platform renklerinde 37 yok
const noPlat37 = parseFeed(
  feed(
    model('Platform', 'Acı Kahve', 1, 'a', { outSizes: [37] }),
    model('Platform', 'Taba', 2, 'b', { outSizes: [37] }),
    model('Tazz', 'Bej', 3, 'c'),
    model('Lifestyle', 'Leopar', 4, 'd', { category: 'Sneaker', price: '1899.00', sale: '1199.00' })
  )
);
setProducts(noPlat37);
const pk = noPlat37.find((p) => p.color === 'Taba');
ok(otherColors(pk, '37').length === 0, 'Platform 37 hiçbir renkte yok -> diğer renk yok');
const sim = similarProducts(pk, '37', 5).map((p) => p.modelName);
ok(sim.includes('Tazz') && !sim.includes('Platform'), `benzer modeller: ${sim.join(', ')} (aynı kategori Tazz önde, Platform hariç)`);
ok(sim[0] === 'Tazz', 'en benzer: aynı kategorideki Tazz (Sneaker değil)');

// --- yükleme / öneri ---
setProducts(list);
const up = suggestForSize('37', [taba.id], 8).map((p) => p.modelName);
ok(up.length >= 5, `37 numaraya upsell önerisi en az 5 ürün (bulunan: ${up.length})`);
ok(up.slice(0, 2).every((m) => m !== 'Platform'), `ilk öneriler siparişteki modelden farklı: ${up.join(', ')}`);
ok(new Set(up.slice(0, 2)).size === 2, 'ilk iki öneri farklı modellerden (çeşitlilik)');

// --- arama ---
ok(searchProducts({ query: 'platform bot', size: '37' }).length >= 2, 'arama: "platform bot" 37 numara');
ok(searchProducts({ query: 'botlar', size: '36' }).length >= 7, 'arama: "botlar" çoğul ekiyle bot ürünleri buluyor');
ok(searchProducts({ query: 'sneaker', size: '37' }).some((p) => p.modelName === 'Lifestyle'), 'arama: sneaker -> Lifestyle');

// --- model/renk ayrımı: tüm modeller aynı açıklamayı paylaşsa bile ---
const sameDesc = parseFeed(
  feed(model('Platform', 'Taba', 1, 'a', { sameDesc: 'Platform' }), model('Tazz', 'Vizon', 2, 'b', { sameDesc: 'Platform' }), model('Tazz', 'Bej', 3, 'c', { sameDesc: 'Platform' }))
);
ok(sameDesc.length === 3 && new Set(sameDesc.map((p) => p.modelKey)).size === 2, 'açıklamalar birebir aynı olsa da modeller doğru ayrıştı (platform, tazz)');

// --- ayrı beden/renk alanı olan feed'ler ---
const variantStyle = `<Products><Product><ProductId>7</ProductId><Name><![CDATA[Beyaz Sneaker]]></Name><Price>849.00</Price><Image1>https://x.com/b.jpg</Image1><Url>https://x.com/p/7</Url>
<Variants><Variant><Size>39</Size><Stock>3</Stock></Variant><Variant><Size>40</Size><Stock>0</Stock></Variant></Variants></Product></Products>`;
const b = parseFeed(variantStyle);
ok(b.length === 1 && b[0].price === 849 && hasSize(b[0], '39') && !hasSize(b[0], '40'), 'Variant tarzı feed (stok adetli) hâlâ okunuyor');

ok(parsePrice('2299.00 TRY') === 2299 && parsePrice('1.299,90 TRY') === 1299.9 && parsePrice('1,299.90') === 1299.9 && parsePrice('849') === 849, 'fiyat biçimleri');

process.exit(fail ? 1 : 0);
