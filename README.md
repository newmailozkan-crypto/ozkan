# Instagram Satış Botu (Claude + Render + Telegram)

Instagram hesabınıza gelen **DM** ve **yorumlara** cevap veren, ürün görsellerini katalogla eşleştiren, sipariş toplayıp **Telegram**'a ileten satış chatbot'u.

## Neler yapıyor?
- DM'lere doğal sohbetle cevap verir, ikna edici satış yapar.
- Müşterinin gönderdiği ürün fotoğrafını analiz edip XML kataloğundaki ürünle eşleştirir (fiyat + bilgi + fotoğraf gönderir).
- Beden/numara stokunu kontrol eder; sadece stokta olan ürünleri önerir.
- Sipariş bilgilerini toplar: isim soyisim, telefon, açık adres, il, ilçe, ürün/beden.
- Bilgiler tamamlanınca müşterinin numarasında olan 5-10 modelin fotoğrafını gönderip 2'li alım kampanyasıyla upsell yapar.
- Sipariş sonunda "24 saat içinde paketlenir, SMS ile bilgilendirilirsiniz" der.
- Siparişi `isim, telefon, adres, il/ilçe, ürünler, nihai fiyat` formatında Telegram'a yollar.
- Gönderi altı yorumlara herkese açık kısa yanıt verir + yorumcuya DM (özel yanıt) gönderir.
- Ürünleri (`FEED_REFRESH_MIN`) ve kampanya/kargo/ödeme sayfalarını (`SITE_REFRESH_MIN`) varsayılan olarak 4,5 saatte bir (270 dk) yeniler; değişiklik olunca bot yeni bilgiyle konuşur.
- Müşteriye yalnızca güncel indirimli satış fiyatını söyler; üstü çizili fiyattan söz etmez.
- Müşterinin fotoğrafı gelir gelmez eşleştirme arka planda başlar, bot cevabını hazırlarken sonuç hazır olur.
- Şikayet/iade/bilemediği durumlarda Telegram'a "insan desteği gerekli" bildirimi atar.

## Mimari
```
Instagram ──webhook──▶ Render (server.js) ──▶ Claude (araçlarla)
                              │                 ├─ search_products / get_product (XML katalog)
                              │                 ├─ match_customer_image (görsel eşleştirme)
                              │                 ├─ send_product_photos / suggest_upsell
                              │                 ├─ submit_order ──▶ Telegram
                              └─ site sayfaları (kampanya/kargo/ödeme) periyodik taranır
```

## Kurulum

### 1) GitHub
Bu klasörü bir GitHub deposuna yükleyin (`.env` dosyasını **yüklemeyin**, `.gitignore` zaten engeller).

```bash
git init && git add . && git commit -m "ilk sürüm"
git branch -M main
git remote add origin https://github.com/KULLANICI/ig-satis-botu.git
git push -u origin main
```

### 2) Telegram botu
1. Telegram'da `@BotFather` → `/newbot` → token'ı alın (`TELEGRAM_BOT_TOKEN`).
2. Botu siparişlerin gideceği gruba/sohbete ekleyin ve bir mesaj yazın.
3. Chat ID için: `https://api.telegram.org/bot<TOKEN>/getUpdates` adresinde `chat.id` değerine bakın (`TELEGRAM_CHAT_ID`; grup ID'leri `-100...` ile başlar).

### 3) Meta / Instagram
1. Instagram hesabınız **Profesyonel (Business/Creator)** olmalı.
2. [developers.facebook.com](https://developers.facebook.com) → Uygulama oluştur → **Instagram** ürününü ekleyin (Instagram API with Instagram Login).
3. İzinler: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`.
4. Hesabınızı bağlayıp **access token** üretin (uzun ömürlü token'a çevirin) → `IG_ACCESS_TOKEN`. Instagram hesap ID'niz → `IG_ACCOUNT_ID`. Uygulama gizli anahtarı → `IG_APP_SECRET`.
5. Webhook (Render'a deploy ettikten sonra):
   - Callback URL: `https://SERVIS-ADINIZ.onrender.com/webhook`
   - Verify token: `IG_VERIFY_TOKEN` ile aynı metin
   - Abone olunacak alanlar: **messages** ve **comments**
6. Canlıda herkese hizmet vermesi için Meta **App Review** (gelişmiş erişim) onayı gerekir. Onaydan önce sadece uygulamaya eklediğiniz test hesaplarıyla çalışır.

### 4) Render
1. Render → **New → Web Service** → GitHub deponuzu seçin (`render.yaml` otomatik okunur).
2. `Environment` bölümüne `.env.example`'daki değişkenleri girin.
3. Deploy sonrası `https://SERVIS.onrender.com/health` adresinde katalog ve site bilgisinin yüklendiğini görün (`catalog.count > 0`).

> **Önemli:** Render'ın ücretsiz planı boşta uyur; Meta webhook'ları ve müşteri mesajları kaçabilir. Canlı kullanım için **Starter** plan önerilir.

## Görsel tabanlı ürün akışı
Müşteri bir ürün fotoğrafı gönderdiğinde bot şu sırayı izler:
1. Görseli analiz eder ve XML katalogdaki adaylarla görsel olarak karşılaştırır.
2. Ürün bulunduysa ve müşterinin numarası **stokta** ise fotoğraf + fiyat + özellik gönderip siparişe yönlendirir.
3. Numara **tükenmişse**, aynı modelin o numarası stokta olan **diğer renklerini** fotoğraflarıyla önerir.
4. Hiçbir renkte yoksa ya da ürün sitede yoksa, görsele **en çok benzeyen** ve numarası stokta olan modelleri önerir.
5. Müşteri ürüne karar verince sipariş bilgilerini toplar.

Renkleri bağlamak için kod; model kodu (`model`, `mpn`) varsa onu, yoksa başlıktan renk kelimelerini çıkararak bulduğu model adını kullanır. Aynı modelin renkleri XML'de aynı başlık yapısıyla (örn. "Deri Spor Ayakkabı Siyah" / "… Beyaz") veya aynı model kodu ile geliyorsa otomatik bağlanır.

İsterseniz sohbet için ucuz bir model (Haiku), görsel eşleştirme için daha güçlü bir model kullanabilirsiniz: `CLAUDE_MODEL=claude-haiku-4-5-20251001` ve `VISION_MODEL=claude-sonnet-5-5`.

## Ürün hafızası (XML'den)
Bot ürünleri belleğinde tutar ve `FEED_REFRESH_MIN` dakikada bir (varsayılan 270 dk) yeniler (fiyat, stok, yeni/silinen ürünler).

**Kaynak sırası (`CATALOG_SOURCE=auto`):** önce `PRODUCT_FEED_URL` (XML). XML okunamazsa veya boş gelirse siteden okunur:
1. WooCommerce Store API (`/wp-json/wc/store/v1/products`): tüm ürünler, fiyat, görsel, açıklama, numara listesi.
2. Store API numara stoklarını vermediği için her ürün sayfasındaki varyasyon verisinden (`data-product_variations`) her numaranın stoğu okunur.
3. Store API kapalıysa `SITE_CATALOG_URL` kategori sayfası `/page/2/, /page/3/…` diye gezilir ve ürün sayfaları okunur (`src/scrape.js`).

`CATALOG_SOURCE=xml` yalnızca XML, `CATALOG_SOURCE=site` yalnızca site kullanır. Hiç ürün yüklenemezse bot 5 dakikada bir tekrar dener. Hangi kaynağın kullanıldığı `/health` ve `/debug/feed` çıktısında `source` / `kaynak` alanında görünür.

Bellekte şunlar bulunur:
- **Renk bazında ürün**: her satır (beden başına bir kayıt) tek ürüne birleştirilir; beden listesi ve her bedenin stok durumu saklanır.
- **Beden**: ayrı alan yoksa ürün linkindeki `attribute_pa_numara=37` parametresinden okunur.
- **Model ve renk**: aynı açıklamayı paylaşan kayıtların başlıkları karşılaştırılır; ortak baş model adı ("Platform"), kalan renktir ("Acı Kahve"). Bu olmazsa başlıktaki bilinen renk kelimeleri renk sayılır. Aynı modelin renkleri böylece birbirine bağlanır.
- **Görsel hafıza**: her ürün görseli ilk görüldüğünde bir kez tanımlanır (tür, stil, taban, materyal, desen) ve bellekte tutulur. Arama, eşleştirme ve "benzer ürün" önerisi bu tanımları kullanır. Tanımlama için `INDEX_MODEL` (varsayılan Haiku) kullanılır, maliyeti çok düşüktür.
- **Benzer ürünler**: kategori, görsel tanımlardaki örtüşme, fiyat yakınlığı ve renk ailesine göre puanlanır; öneriler farklı modellerden seçilir.

**Görsel biçimi:** Instagram DM webp'i destekliyorsa ürün görselleri olduğu gibi gönderilir (varsayılan). Desteklemediği görülürse `CONVERT_WEBP=true` yapın: sunucu görselleri `/img/...jpg` adresinden JPEG olarak sunar (`sharp` paketi gerekir, otomatik kurulur). Görsel hiç gitmezse bot ürün adı, fiyat ve linki yazı olarak gönderir.

**Teşhis adresleri** (hepsi `?key=IG_VERIFY_TOKEN_DEĞERİNİZ` ister):
- `/debug/feed`: XML'de kaç kayıt bulunduğu, kaç ürün/model/görsel tanımı olduğu, ham örnek kayıtlar
- `/debug/catalog?q=platform`: ürünler, renkleri, her bedenin stok durumu (✓/✗), fiyat, görsel tanımı
- `/debug/families`: modeller, renkleri ve her modele en benzeyen diğer modeller

## Ortam değişkenleri
| Değişken | Açıklama |
|---|---|
| `IG_VERIFY_TOKEN` | Webhook doğrulama metni (kendiniz belirleyin) |
| `IG_APP_SECRET` | Meta uygulama gizli anahtarı (imza doğrulaması) |
| `IG_ACCESS_TOKEN` | Instagram erişim token'ı |
| `IG_ACCOUNT_ID` | Instagram profesyonel hesap ID |
| `ANTHROPIC_API_KEY` | Claude API anahtarı |
| `CLAUDE_MODEL` | Sohbet modeli. Varsayılan `claude-sonnet-5-5` |
| `VISION_MODEL` | (Opsiyonel) Görsel eşleştirme modeli; boşsa `CLAUDE_MODEL` |
| `INDEX_MODEL` | (Opsiyonel) Ürün görsellerini tanımlayan model; varsayılan `claude-haiku-4-5-20251001` |
| `PUBLIC_BASE_URL` | (Opsiyonel) Servisin herkese açık adresi; Render `RENDER_EXTERNAL_URL` ile kendisi verir |
| `STORE_NAME` | Mağaza adı (bot kendini böyle tanıtır) |
| `PRODUCT_FEED_URL` | Ürün XML linkiniz |
| `SITE_INFO_URLS` | Kampanya/kargo/ödeme/iade sayfa linkleri (virgülle) |
| `FEED_REFRESH_MIN` / `SITE_REFRESH_MIN` | Ürün ve site bilgisi yenileme sıklığı (dakika). Varsayılan 270 (4,5 saat) |
| `CATALOG_SOURCE` | `auto` (önce XML, olmazsa site), `xml` veya `site` |
| `SITE_CATALOG_URL` | Siteden okuma yedeği için tüm ürünlerin kategori sayfası (örn. `https://siteniz.com/product-category/tum-urunler/`) |
| `CONVERT_WEBP` | `true` ise webp görseller JPEG'e çevrilip gönderilir (varsayılan kapalı) |
| `CAMPAIGN_RULES` | (Opsiyonel) Örn. `2:300,3:600` → 2+ üründe 300 TL, 3+ üründe 600 TL. Verilirse indirimi sunucu hesaplar, bot değiştiremez. Verilmezse bot indirimi site bilgisinden okur (en fazla %40 ile sınırlı). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Sipariş bildirimi |

## XML formatı hakkında
Kod Google Merchant / Facebook feed'i, ve `<Product>…<Variants><Variant><Size>/<Stock>` tarzı yaygın e-ticaret XML'lerini tanımaya çalışır (farklı alan adlarını dener, aynı `item_group_id`'li satırları tek ürün + bedenler olarak birleştirir). Kendi XML'inizde alan adları farklıysa `src/catalog.js` içindeki `normalize()` ve `extractSizes()` fonksiyonlarındaki isim listelerine ekleme yapmanız yeterli. Test için: `npm run test:feed`. Sağlık adresinde `catalog.count` 0 çıkarsa XML'den bir örnek ürün kopyalayıp bana gönderin, alan eşlemesini birlikte düzeltelim.

## Bilmeniz gerekenler
- **24 saat kuralı:** Instagram, müşterinin son mesajından sonra 24 saat içinde cevap vermenize izin verir. Yorum "özel yanıtı" (private reply) yorum başına 1 kez ve 7 gün içinde kullanılabilir ve sadece metin gönderir; fotoğraflar müşteri DM'den yazınca gönderilir.
- **Bellek:** Konuşma geçmişi bellekte tutulur; sunucu yeniden başlarsa sipariş toplama yarım kalan müşteriler baştan başlar. Kalıcılık istenirse Redis/Postgres eklenebilir.
- **Ürün görselleri** herkese açık `https://` adres olmalı (Instagram bunları indirir).
- **Sipariş kaydı:** Siparişler Telegram'a gider ve Render loglarına `[ORDER]` olarak yazılır. Telegram'a ulaşılamazsa bot müşteriye siparişi aldığını söylemez.
- **Maliyet:** Her mesaj Claude API kullanır; görsel eşleştirme ek 2 çağrı yapar. Sistem istemi önbelleğe alınır.
- Bot, kampanya/kargo/ödeme için yalnızca site sayfalarındaki bilgiyi kullanır; sayfa yapısı değişirse `SITE_INFO_URLS` içindeki linkleri güncelleyin. Kampanya, kargo ve iade bilgileri çoğu mağazada ürün sayfasında da yer alır; bir ürün sayfasını (örn. `https://siteniz.com/product/ornek-urun/`) `SITE_INFO_URLS`'e eklemek botun bu bilgileri bilmesini sağlar.
- Stoklar 4,5 saatte bir güncellendiği için bu aralıkta tükenen bir numara bot için hâlâ stokta görünebilir; siparişler Telegram'a düştüğünde ekibiniz stoğu doğrulamalıdır.


## Katalog yüklenemezse (v2.1)

- Açılışta Telegram'a "✅ Katalog yüklendi (kaynak, ürün sayısı)" ya da "⚠️ KATALOG YÜKLENEMEDİ (tam hata)" mesajı gelir.
- Durumu görmek için: `https://SERVİSİN.onrender.com/debug/status?key=IG_VERIFY_TOKEN` (deneme kaydı, hangi env tanımlı) ve `/health`.
- Kaynak sırası: XML → site (Store API / kategori sayfası) → `data/feed.xml` (elle yüklenen kopya, bkz. `data/README.md`).
- Sitenizde 403 görürseniz: güvenlik duvarında Render çıkış IP'lerine izin verin veya `/wp-content/uploads/woo-product-feed-pro/*` ile `/wp-json/wc/store/*` yollarını bot korumasından hariç tutun; ya da `data/feed.xml` yükleyin.
- Katalog boşken bot "ürün yok" demez; ekibe haber verir ve müşteriden iletişim bilgisi alır.
- Müşteri görseli eşleşince (güven ≥ %45) ürün/diğer renk/benzer model fotoğrafları sunucu tarafından otomatik gönderilir. `npm test` üç test dosyasını çalıştırır.

## Cloudflare engelliyorsa: WordPress'ten aktarım
`wordpress/katalog-gonder.php` snippet'i sitenin kendi sunucusundan, saatte bir XML değiştiyse Render'a gönderir (`/catalog/push`). Render'da `CATALOG_PUSH_KEY` tanımlayın, snippet'teki 3 sabiti doldurun. Cloudflare ayarına dokunmak gerekmez.

## Push modu (v2.5)
`CATALOG_PUSH_KEY` tanımlıysa bot canlı siteye/XML'e gitmez; yalnızca WordPress'in gönderdiği veriyi kullanır. Son veri `CATALOG_STORE_FILE` yoluna yazılır; bot yeniden başlarsa oradan yüklenir. WordPress 6 saatten uzun süre ulaşmazsa Telegram'a uyarı gider, bot son bilinen stoklarla devam eder. Render'da kalıcı veri için Starter plan + Disk (Mount Path `/var/data`) önerilir; ücretsiz planda disk silinir ve bot, WordPress'in bir sonraki saatlik temasına kadar kataloğu bekler.

## Canlı WooCommerce verisi (v3.0)
`wordpress/katalog-canli.php` kod parçacığı ürünleri XML'e bağlı kalmadan doğrudan WooCommerce veritabanından okur (fiyat, numara, numara bazlı stok, görseller) ve `/catalog/push-json` adresine gönderir. Ağır işlem (ürünleri derleme) yalnızca stok/ürün değişince (60 sn içinde), bot kataloğu kaybedince veya günde 1 kez güvence olarak (CB_SAFETY_HOURS) çalışır; 5 dakikalık kontrol yalnızca botа küçük bir durum sorusudur. Bu kod parçacığı etkinken eski XML kod parçacığını kapatın (XML gönderimleri zaten yok sayılır).
Bot uyandığında katalog boşsa mesajlara cevap vermeden en fazla `CATALOG_WAIT_MIN` (varsayılan 12) dakika WordPress'ten veri bekler; gelmezse ekibe yönlendirir.
Test: `npm test`. `test-fixtures/woo-harness.php`, PHP kod parçacığını sahte WooCommerce ile çalıştırıp test-fixtures/woo-list.json çıktısını üretir (`php test-fixtures/woo-harness.php wordpress/katalog-canli.php test-fixtures/woo-list.json`).
