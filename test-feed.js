// Örnek feed ile XML ayrıştırmayı test eder: npm run test:feed
import { parseFeed, searchProducts, hasSize, parsePrice } from './src/catalog.js';

const googleStyle = `<?xml version="1.0"?>
<rss xmlns:g="http://base.google.com/ns/1.0"><channel>
<item><g:id>101-40</g:id><g:item_group_id>101</g:item_group_id><title>Siyah Deri Spor Ayakkabı</title><g:price>1.299,90 TRY</g:price><g:sale_price>999,90 TRY</g:sale_price><g:availability>in stock</g:availability><g:size>40</g:size><g:image_link>https://x.com/a.jpg</g:image_link><link>https://x.com/p/101</link><g:color>Siyah</g:color></item>
<item><g:id>101-41</g:id><g:item_group_id>101</g:item_group_id><title>Siyah Deri Spor Ayakkabı</title><g:price>1.299,90 TRY</g:price><g:sale_price>999,90 TRY</g:sale_price><g:availability>out of stock</g:availability><g:size>41</g:size><g:image_link>https://x.com/a.jpg</g:image_link></item>
<item><g:id>101-42</g:id><g:item_group_id>101</g:item_group_id><title>Siyah Deri Spor Ayakkabı</title><g:price>1.299,90 TRY</g:price><g:sale_price>999,90 TRY</g:sale_price><g:availability>in stock</g:availability><g:size>42</g:size><g:image_link>https://x.com/a.jpg</g:image_link></item>
</channel></rss>`;

const variantStyle = `<Products><Product><ProductId>7</ProductId><Name><![CDATA[Beyaz Sneaker]]></Name><Price>849.00</Price><Image1>https://x.com/b.jpg</Image1><Url>https://x.com/p/7</Url>
<Variants><Variant><Size>39</Size><Stock>3</Stock></Variant><Variant><Size>40</Size><Stock>0</Stock></Variant></Variants></Product></Products>`;

let fail = 0;
const ok = (c, m) => {
  console.log(c ? 'OK  ' : 'FAIL', m);
  if (!c) fail++;
};

const a = parseFeed(googleStyle);
ok(a.length === 1, 'Google feed: 3 satır 1 ürüne gruplandı');
ok(a[0].price === 999.9, `indirimli fiyat okundu (${a[0].price})`);
ok(a[0].priceOriginal === 1299.9, `eski fiyat okundu (${a[0].priceOriginal})`);
ok(hasSize(a[0], '40') && !hasSize(a[0], '41') && hasSize(a[0], '42'), 'beden stokları doğru (40,42 var; 41 yok)');

const b = parseFeed(variantStyle);
ok(b.length === 1 && b[0].price === 849, 'Variant tarzı feed okundu');
ok(hasSize(b[0], '39') && !hasSize(b[0], '40'), 'variant stokları doğru');

ok(parsePrice('1.299,90 TRY') === 1299.9 && parsePrice('1,299.90') === 1299.9 && parsePrice('849') === 849 && parsePrice('1.299') === 1299, 'fiyat biçimleri');

process.exit(fail ? 1 : 0);
