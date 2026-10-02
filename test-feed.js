// Örnek feed ile XML ayrıştırma ve renk/beden akışını test eder: npm run test:feed
import { parseFeed, setProducts, getProduct, hasSize, otherColors, similarProducts, parsePrice } from './src/catalog.js';

const row = (id, group, title, color, size, avail, cat = 'Spor Ayakkabı') =>
  `<item><g:id>${id}</g:id><g:item_group_id>${group}</g:item_group_id><title>${title}</title><g:price>1.299,90 TRY</g:price><g:sale_price>999,90 TRY</g:sale_price><g:availability>${avail}</g:availability><g:size>${size}</g:size><g:color>${color}</g:color><g:product_type>${cat}</g:product_type><g:image_link>https://x.com/${id}.jpg</g:image_link><link>https://x.com/p/${group}</link></item>`;

const googleStyle = `<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel>
${row('101-40', '101', 'Deri Spor Ayakkabı Siyah', 'Siyah', '40', 'in stock')}
${row('101-41', '101', 'Deri Spor Ayakkabı Siyah', 'Siyah', '41', 'out of stock')}
${row('101-42', '101', 'Deri Spor Ayakkabı Siyah', 'Siyah', '42', 'in stock')}
${row('102-41', '102', 'Deri Spor Ayakkabı Beyaz', 'Beyaz', '41', 'in stock')}
${row('102-42', '102', 'Deri Spor Ayakkabı Beyaz', 'Beyaz', '42', 'out of stock')}
${row('103-41', '103', 'Hafif Koşu Ayakkabısı Gri', 'Gri', '41', 'in stock', 'Koşu')}
${row('104-43', '104', 'Deri Spor Ayakkabı Taba', 'Taba', '43', 'in stock')}
</channel></rss>`;

const variantStyle = `<Products><Product><ProductId>7</ProductId><Name><![CDATA[Beyaz Sneaker]]></Name><Price>849.00</Price><Image1>https://x.com/b.jpg</Image1><Url>https://x.com/p/7</Url>
<Variants><Variant><Size>39</Size><Stock>3</Stock></Variant><Variant><Size>40</Size><Stock>0</Stock></Variant></Variants></Product></Products>`;

let fail = 0;
const ok = (c, m) => {
  console.log(c ? 'OK  ' : 'FAIL', m);
  if (!c) fail++;
};

const list = parseFeed(googleStyle);
ok(list.length === 4, `renk başına ayrı ürün (${list.length} ürün; beklenen 4: siyah, beyaz, gri, taba)`);
setProducts(list);
const siyah = list.find((p) => p.color === 'Siyah');
const beyaz = list.find((p) => p.color === 'Beyaz');
ok(siyah.price === 999.9 && siyah.priceOriginal === 1299.9, 'indirimli/eski fiyat okundu');
ok(hasSize(siyah, '40') && !hasSize(siyah, '41') && hasSize(siyah, '42'), 'siyah: 40 ve 42 var, 41 yok');
ok(hasSize(beyaz, '41') && !hasSize(beyaz, '42'), 'beyaz: 41 var, 42 yok');

// Senaryo 1: müşteri siyah 41 istiyor -> siyahta yok -> beyaz 41 önerilmeli
const oc41 = otherColors(siyah, '41').map((p) => p.color);
ok(oc41.includes('Beyaz') && !oc41.includes('Taba'), `siyah 41 yok -> diğer renk: ${oc41.join(',')}`);

// Senaryo 2: müşteri beyaz 42 istiyor -> beyazda yok -> siyah 42 önerilmeli
ok(otherColors(beyaz, '42').some((p) => p.color === 'Siyah'), 'beyaz 42 yok -> siyah 42 öneriliyor');

// Senaryo 3: taba 44 -> hiçbir renkte yok -> benzer modeller (aynı kategori) 44 de yok -> boş; 41 için benzer gelir
const taba = list.find((p) => p.color === 'Taba');
ok(otherColors(taba, '41').length >= 1, 'taba 41 yok -> diğer renkler (siyah/beyaz 41... ) bulunuyor');
const gri = list.find((p) => p.color === 'Gri');
ok(otherColors(gri, '41').length === 0, 'koşu ayakkabısı tek renk: diğer renk yok');
ok(similarProducts(gri, '41').length >= 1, 'koşu ayakkabısı 41 için benzer modeller bulunuyor (spor ayakkabılar)');

const b = parseFeed(variantStyle);
ok(b.length === 1 && b[0].price === 849, 'Variant tarzı feed okundu');
ok(hasSize(b[0], '39') && !hasSize(b[0], '40'), 'variant stokları doğru');

ok(parsePrice('1.299,90 TRY') === 1299.9 && parsePrice('1,299.90') === 1299.9 && parsePrice('849') === 849 && parsePrice('1.299') === 1299, 'fiyat biçimleri');

process.exit(fail ? 1 : 0);
